/**
 * pi-rooms — storage layer.
 *
 * File-based, no daemon. Everything here is a plain function over an explicit
 * base directory so it can be unit-tested without pi running.
 *
 * Layout under the base directory (default ~/.pi/agent/rooms):
 *
 *   registry/<name>.json          live agent presence, keyed by name
 *   inbox/<name>/*.json           undelivered messages for one agent
 *   inbox/<name>/read/*.json      delivered messages, kept for reply_all lookup
 *   rooms/<room>/room.json        room metadata: members, creator
 *   rooms/<room>/log.jsonl        append-only room history, one post per line
 *
 * Liveness is a pid *plus* the identity of the process behind it. A bare pid is
 * not enough: after a reboot the same number is handed to an unrelated process,
 * and a stale registration then reads as alive forever. Every registration
 * therefore records the boot id and, where the platform exposes one, the
 * process start time, and both are compared on read.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

/** Longest message accepted. Longer text is truncated with a marker, not rejected. */
export const MAX_MESSAGE_CHARS = 4000;

/** Delivered messages kept per agent for reply_all lookup, oldest pruned first. */
export const READ_HISTORY_LIMIT = 200;

export interface Registration {
  name: string;
  pid: number;
  cwd: string;
  /** Boot id the process was registered under; a mismatch means it cannot be the same process. */
  bootId?: string;
  /**
   * Opaque platform process identity captured at registration.
   *
   * On Linux this is `<starttime>:<state>` from /proc/<pid>/stat. Comparing it
   * on read is what makes pid reuse detectable: the number can be reused, the
   * (starttime, state) pair cannot be forged by an unrelated process that
   * started later.
   */
  procId?: string;
  model?: string;
  sessionId?: string;
  startedAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: string;
  from: string;
  to: string[];
  text: string;
  sentAt: string;
  /** When the message was written into an inbox. Set by `deliver`. */
  queuedAt?: string;
  /** When the recipient's session was handed the message. Set by `archive`. */
  deliveredAt?: string;
  /** Recipients whose inbox accepted the message, with the per-recipient queue time. */
  receipts?: Record<string, Receipt>;
  /** Set when the message was posted into a room. */
  room?: string;
  /** Position in the room log at the time of posting, 1-based. */
  roomSeq?: number;
  /** Message id this one answers, when produced by reply_all. */
  replyTo?: string;
}

/**
 * What the extension can honestly observe about one message.
 *
 * `queued` means a file exists in the recipient's inbox; `delivered` means the
 * recipient's own session was handed it through `pi.sendMessage`. There is
 * deliberately no `read` state: the extension cannot see what a model does with
 * a message once its session has it, and a receipt that claimed otherwise would
 * be worse than none.
 */
export interface Receipt {
  queuedAt: string;
  deliveredAt?: string;
}

export interface Room {
  name: string;
  members: string[];
  createdBy: string;
  createdAt: string;
}

export interface RoomPost {
  /** Message id, so the post can be joined to its delivery receipts. */
  id?: string;
  from: string;
  text: string;
  sentAt: string;
  /** Members the post was fanned out to (everyone else in the room). */
  recipients: string[];
}

export interface Paths {
  base: string;
  registry: string;
  inbox: string;
  rooms: string;
  receipts: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidName(value: string): boolean {
  return NAME_RE.test(value);
}

export function isValidRoom(value: string): boolean {
  return ROOM_RE.test(value);
}

export function resolvePaths(base: string): Paths {
  return {
    base,
    registry: path.join(base, "registry"),
    inbox: path.join(base, "inbox"),
    rooms: path.join(base, "rooms"),
    receipts: path.join(base, "receipts"),
  };
}

export function resolveBase(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.PI_ROOMS_DIR ?? "").trim();
  return explicit.length > 0 ? explicit : path.join(homedir(), ".pi", "agent", "rooms");
}

/**
 * Default identity when the operator has not named the agent.
 *
 * Derived from the working directory, so it is stable across restarts and
 * distinct per worktree, which matters for a fleet that runs several agents
 * out of sibling checkout directories. `PI_ROOMS_NAME` and `PI_AGENT_NAME`
 * take precedence so an operator can pin real names instead.
 */
export function defaultName(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ["PI_ROOMS_NAME", "PI_AGENT_NAME"] as const) {
    const value = (env[key] ?? "").trim();
    if (value.length > 0) {
      const slug = slugify(value);
      if (isValidName(slug)) return slug;
    }
  }
  const slug = slugify(path.basename(cwd) || "root");
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 4);
  return `${slug.slice(0, 40)}-${digest}`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "agent";
}

/** Replace control characters so a message cannot drive the receiving terminal. */
export function sanitize(text: string): string {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (cleaned.length <= MAX_MESSAGE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_MESSAGE_CHARS)}\n… [truncated ${cleaned.length - MAX_MESSAGE_CHARS} chars]`;
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Identity of the current boot, or null where the platform has none.
 *
 * A registration made in an earlier boot can never refer to a live process,
 * however plausible its pid looks afterwards.
 */
export function bootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Opaque process identity for a pid, or null when the platform cannot supply one.
 *
 * Linux only: reads `<starttime>:<state>` out of /proc/<pid>/stat. The command
 * name field is parenthesised and may itself contain spaces and parentheses, so
 * the fields are located after the final ')' rather than split on whitespace.
 *
 * The state is kept so a zombie can be reported as dead: `process.kill(pid, 0)`
 * succeeds for a zombie, and a zombie will never read its inbox.
 */
export function procIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  if (close === -1) return null;
  // After "comm)" come: state ppid pgrp session tty_nr tpgid flags minflt ...
  // starttime is field 22 overall, and field 3 is state, so within this tail
  // state is index 0 and starttime index 19.
  const tail = raw.slice(close + 1).trim().split(/\s+/);
  const state = tail[0];
  const starttime = tail[19];
  if (state == null || starttime == null) return null;
  return `${starttime}:${state}`;
}

/** True when a recorded proc identity is one no live process can present. */
function isDeadState(procId: string | null | undefined): boolean {
  if (procId == null) return false;
  const state = procId.split(":")[1];
  // Z zombie, X/x dead, T/t stopped are all unable to make progress; Z is the
  // one that matters, because it still answers kill(pid, 0) successfully.
  return state === "Z" || state === "X" || state === "x";
}

/**
 * Whether a registration still refers to the process that wrote it.
 *
 * Three independent checks, cheapest first:
 *
 * 1. pid exists at all;
 * 2. it belongs to this boot, when the platform reports a boot id;
 * 3. its start time matches the one recorded, so a reused pid is caught;
 * 4. it is not a zombie, which would otherwise pass check 1 forever.
 *
 * Where the platform supplies no proc identity (non-Linux), this degrades to
 * the pid check alone — the same behaviour as before, stated rather than
 * assumed.
 */
export function isRegistrationLive(reg: Registration): boolean {
  if (!isAlive(reg.pid)) return false;
  const current = bootId();
  if (reg.bootId != null && current != null && reg.bootId !== current) return false;
  const identity = procIdentity(reg.pid);
  if (identity != null && reg.procId != null) {
    // A dead state is checked first: a zombie keeps its starttime, so the
    // mismatch test would otherwise report it as a reused pid and mislabel the
    // one failure a human could actually clear by reaping.
    if (isDeadState(identity)) return false;
    if (identity !== reg.procId) return false;
  }
  return true;
}

/** Why a registration is considered gone, for diagnostics. */
export function livenessDiagnosis(reg: Registration): string | null {
  if (!isAlive(reg.pid)) return "no such process";
  const current = bootId();
  if (reg.bootId != null && current != null && reg.bootId !== current) return "registered in an earlier boot";
  const identity = procIdentity(reg.pid);
  if (identity != null && reg.procId != null) {
    if (isDeadState(identity)) return "process is a zombie";
    if (identity !== reg.procId) return "pid was reused by another process";
  }
  return null;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export function readRegistration(paths: Paths, name: string): Registration | null {
  if (!isValidName(name)) return null;
  return readJson<Registration>(path.join(paths.registry, `${name}.json`));
}

/**
 * Every registration whose process is still running.
 *
 * Dead entries are removed as a side effect, so presence never accumulates
 * ghosts when an agent is killed rather than shut down cleanly.
 */
export interface RosterEntry extends Registration {
  /** Null when the agent is live; a reason when it is not. */
  gone: string | null;
}

/**
 * Every registration, live or not, with the reason it is gone.
 *
 * Callers that must not lie about who is reachable use this; callers that want
 * a clean roster use {@link listAgents}. Reporting a stale name as present is
 * worse than reporting nothing, because during a restart it is exactly what
 * gets acted on.
 */
export function readRoster(paths: Paths): RosterEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(paths.registry).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const roster: RosterEntry[] = [];
  for (const file of files) {
    const reg = readJson<Registration>(path.join(paths.registry, file));
    if (reg == null) {
      try {
        fs.unlinkSync(path.join(paths.registry, file));
      } catch {
        /* another process pruned it first */
      }
      continue;
    }
    roster.push({ ...reg, gone: livenessDiagnosis(reg) });
  }
  return roster.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every registration whose process is still running.
 *
 * Dead entries are removed as a side effect, so presence never accumulates
 * ghosts when an agent is killed rather than shut down cleanly. A reused pid
 * or an entry from an earlier boot is dead here even though the number is
 * still in use.
 */
export function listAgents(paths: Paths): Registration[] {
  const live: Registration[] = [];
  for (const entry of readRoster(paths)) {
    if (entry.gone != null) {
      try {
        fs.unlinkSync(path.join(paths.registry, `${entry.name}.json`));
      } catch {
        /* another process pruned it first */
      }
      continue;
    }
    const { gone: _gone, ...registration } = entry;
    live.push(registration);
  }
  return live;
}

/**
 * Reserve a name for this process.
 *
 * A name already held by another live process is never taken over; the caller
 * gets a suffixed variant instead. Two agents silently sharing one name would
 * merge two inboxes into one, which is the failure this prevents.
 */
export function claimName(paths: Paths, desired: string, pid: number): string {
  const base = isValidName(desired) ? desired : slugify(desired);
  let candidate = base;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const existing = readRegistration(paths, candidate);
    if (existing == null || !isRegistrationLive(existing) || existing.pid === pid) return candidate;
    candidate = `${base.slice(0, 44)}-${pid}`;
    if (attempt > 0) candidate = `${base.slice(0, 40)}-${pid}-${attempt}`;
  }
  return `${base.slice(0, 40)}-${pid}-${randomUUID().slice(0, 4)}`;
}

export function register(paths: Paths, entry: Registration): void {
  writeJsonAtomic(path.join(paths.registry, `${entry.name}.json`), entry);
}

export function unregister(paths: Paths, name: string): void {
  try {
    fs.unlinkSync(path.join(paths.registry, `${name}.json`));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

function inboxDir(paths: Paths, name: string): string {
  return path.join(paths.inbox, name);
}

export interface PendingMessage {
  file: string;
  message: Delivery;
}

/** Write one delivery into every recipient's inbox. The sender's own box is skipped. */
/**
 * Write one delivery into every recipient's inbox. The sender's own box is skipped.
 *
 * Each copy records its own `queuedAt`, and the shared receipt file is updated
 * so the sender can later ask what the extension observed.
 */
export function deliver(paths: Paths, message: Delivery): string[] {
  const written: string[] = [];
  const stamp = Date.now();
  const queuedAt = new Date(stamp).toISOString();
  for (const [index, recipient] of message.to.entries()) {
    if (!isValidName(recipient) || recipient === message.from) continue;
    const dir = inboxDir(paths, recipient);
    ensureDir(dir);
    const file = path.join(dir, `${stamp}-${index}-${message.id.slice(0, 8)}.json`);
    writeJsonAtomic(file, { ...message, queuedAt });
    written.push(recipient);
    recordReceipt(paths, message.id, recipient, { queuedAt });
  }
  return written;
}

function receiptPath(paths: Paths, id: string): string {
  return path.join(paths.receipts, `${id}.json`);
}

/** Where a message's receipt file lives, for callers that report it to a human. */
export function receiptPathFor(paths: Paths, id: string): string {
  return receiptPath(paths, id);
}

function recordReceipt(paths: Paths, id: string, recipient: string, patch: Partial<Receipt>): void {
  const file = receiptPath(paths, id);
  const existing = readJson<{ id: string; receipts: Record<string, Receipt> }>(file) ?? {
    id,
    receipts: {},
  };
  const current = existing.receipts[recipient] ?? ({} as Receipt);
  // Never move a timestamp backwards: a repeated call is not new information.
  existing.receipts[recipient] = {
    queuedAt: current.queuedAt ?? patch.queuedAt ?? new Date().toISOString(),
    deliveredAt: current.deliveredAt ?? patch.deliveredAt,
  };
  writeJsonAtomic(file, existing);
}

/** What the extension observed for one message, or null when it never saw it. */
export interface ReceiptRecord {
  id: string;
  receipts: Record<string, Receipt>;
}

export function readReceipts(paths: Paths, id: string): ReceiptRecord | null {
  if (!/^[0-9a-f-]{8,}$/i.test(id)) return null;
  return readJson<ReceiptRecord>(receiptPath(paths, id));
}

/**
 * Record that a recipient's session was handed a message.
 *
 * Called by the delivery loop immediately before `pi.sendMessage`, which is the
 * last moment the extension can observe anything.
 */
export function markDelivered(paths: Paths, id: string, recipient: string): void {
  recordReceipt(paths, id, recipient, { deliveredAt: new Date().toISOString() });
}

/** Undelivered messages for one agent, oldest first. */
export function drain(paths: Paths, name: string): PendingMessage[] {
  const dir = inboxDir(paths, name);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const pending: PendingMessage[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const message = readJson<Delivery>(full);
    if (message == null) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
      continue;
    }
    pending.push({ file: full, message });
  }
  return pending;
}

/**
 * Move a delivered message out of the inbox and into `read/`.
 *
 * It is kept rather than deleted so `reply_all` can resolve a message id back
 * to its recipient set long after delivery.
 */
export function archive(paths: Paths, name: string, file: string, message: Delivery): void {
  const readDir = path.join(inboxDir(paths, name), "read");
  ensureDir(readDir);
  const target = path.join(readDir, path.basename(file));
  const deliveredAt = new Date().toISOString();
  const stamped: Delivery = {
    ...message,
    queuedAt: message.queuedAt ?? deliveredAt,
    deliveredAt: message.deliveredAt ?? deliveredAt,
  };
  try {
    fs.renameSync(file, target);
  } catch {
    return;
  }
  writeJsonAtomic(path.join(readDir, `${message.id}.json`), stamped);
  markDelivered(paths, message.id, name);
  pruneReadHistory(paths, name);
}

function pruneReadHistory(paths: Paths, name: string): void {
  const readDir = path.join(inboxDir(paths, name), "read");
  let files: string[];
  try {
    files = fs.readdirSync(readDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch {
    return;
  }
  if (files.length <= READ_HISTORY_LIMIT) return;
  const stats = files
    .map((f) => {
      const full = path.join(readDir, f);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .sort((a, b) => a.mtime - b.mtime);
  for (const entry of stats.slice(0, stats.length - READ_HISTORY_LIMIT)) {
    try {
      fs.unlinkSync(entry.full);
    } catch {
      /* ignore */
    }
  }
}

/** Look up a message this agent received, delivered or not. */
export function findReceived(paths: Paths, name: string, id: string): Delivery | null {
  const dir = inboxDir(paths, name);
  const candidates = [
    path.join(dir, "read", `${id}.json`),
    ...safeReaddir(dir)
      .filter((f) => f.endsWith(".json") && f.includes(id.slice(0, 8)))
      .map((f) => path.join(dir, f)),
  ];
  for (const candidate of candidates) {
    const message = readJson<Delivery>(candidate);
    if (message != null && message.id === id) return message;
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function roomDir(paths: Paths, room: string): string {
  return path.join(paths.rooms, room);
}

export function readRoom(paths: Paths, room: string): Room | null {
  if (!isValidRoom(room)) return null;
  return readJson<Room>(path.join(roomDir(paths, room), "room.json"));
}

export function saveRoom(paths: Paths, room: Room): void {
  writeJsonAtomic(path.join(roomDir(paths, room.name), "room.json"), room);
}

export function listRooms(paths: Paths): Room[] {
  const rooms: Room[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.rooms);
  } catch {
    return rooms;
  }
  for (const entry of entries) {
    const room = readJson<Room>(path.join(paths.rooms, entry, "room.json"));
    if (room != null) rooms.push(room);
  }
  return rooms.sort((a, b) => a.name.localeCompare(b.name));
}

export function createRoom(paths: Paths, room: Room): Room {
  saveRoom(paths, room);
  ensureDir(roomDir(paths, room.name));
  return room;
}

function logPath(paths: Paths, room: string): string {
  return path.join(roomDir(paths, room), "log.jsonl");
}

/** Number of posts in the room log. */
export function roomSeq(paths: Paths, room: string): number {
  return readPosts(paths, room, 0, Number.MAX_SAFE_INTEGER).length;
}

/**
 * Append one post to the room log.
 *
 * The log carries no sequence number: position in the file *is* the order, so
 * concurrent appenders cannot disagree about what came next. A single small
 * append per post is atomic on the platforms this runs on.
 */
export function appendPost(paths: Paths, room: string, post: RoomPost): number {
  const file = logPath(paths, room);
  ensureDir(path.dirname(file));
  const seq = roomSeq(paths, room) + 1;
  fs.appendFileSync(file, `${JSON.stringify(post)}\n`, { mode: 0o600 });
  return seq;
}

export interface NumberedPost extends RoomPost {
  seq: number;
}

/**
 * Read room history.
 *
 * `since` is exclusive and 1-based, so an agent that has seen up to #12 asks
 * for `since: 12` and gets #13 onward. `limit` returns the most recent entries
 * when the history is longer.
 */
export function readPosts(paths: Paths, room: string, since = 0, limit = 50): NumberedPost[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath(paths, room), "utf8");
  } catch {
    return [];
  }
  const posts: NumberedPost[] = [];
  let seq = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    seq += 1;
    let parsed: RoomPost;
    try {
      parsed = JSON.parse(line) as RoomPost;
    } catch {
      continue;
    }
    if (seq <= since) continue;
    posts.push({ ...parsed, seq });
  }
  return posts.length > limit ? posts.slice(posts.length - limit) : posts;
}

export function uniqueMembers(members: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const member of members) {
    const name = member.trim();
    if (name.length === 0 || !isValidName(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
