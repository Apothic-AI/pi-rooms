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
  /**
   * Correlation attributes, captured from the process environment.
   *
   * These are deliberately *not* identity. A herdr pane id is positional and is
   * recycled, so it says nothing on its own; paired with the proc identity below
   * it says "this name is this pane, right now", and the moment it stops being
   * true the liveness checks say so. Undefined off herdr.
   */
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
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
 * What can honestly be said about one message.
 *
 * `queued` means a file exists in the recipient's inbox; `delivered` means the
 * recipient's own session was handed it through `pi.sendMessage`. The extension
 * writes only those two: it cannot see what a model does with a message once
 * its session has it, and a receipt that claimed otherwise would be worse than
 * none.
 *
 * `readAt` is written by a *client*, not by the extension. A client is the
 * renderer, so it can attest exactly when the bytes became visible on a screen;
 * that is a different holder class making a claim about a different fact, not
 * the extension inventing knowledge. It is additive and optional, so a lane
 * running older code never writes it and never needs it.
 */
export interface Receipt {
  queuedAt: string;
  deliveredAt?: string;
  /** When a client rendered the message to a human. First read wins. */
  readAt?: string;
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

/**
 * Whether two proc identities name the same process *start*.
 *
 * Identity is the start time alone. The state letter rides inside the identity
 * string so a zombie can be reported, but it also changes whenever a process
 * sleeps or runs — and a pi lane does that on every turn. Comparing the whole
 * string therefore treats a healthy lane as a reused pid and prunes its
 * registration, or rejects its pin, the moment it goes idle.
 */
export function sameProcessStart(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  return a.split(":")[0] === b.split(":")[0];
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
    if (!sameProcessStart(identity, reg.procId)) return false;
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
    if (!sameProcessStart(identity, reg.procId)) return "pid was reused by another process";
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
// Locking shared JSON
// ---------------------------------------------------------------------------

/**
 * A lock older than this, held by a process that is gone, is abandoned.
 *
 * The unit is deliberately seconds-of-wall-clock, not milliseconds-of-work: the
 * only fact that makes removal safe is that the holder cannot still be inside
 * its critical section, and a dead pid plus a wide age margin is the cheapest
 * honest evidence of that.
 */
const LOCK_STALE_MS = 10_000;

/** Waits before giving up. Bounded on purpose — see {@link withFileLock}. */
const LOCK_RETRIES = 5;

/** Linear backoff between waits: 25, 50, 75, 100, 125ms. */
const LOCK_BACKOFF_MS = 25;

interface LockFile {
  pid: number;
  startedAt: string;
}

/**
 * Sleep without a timer, so this stays usable from a synchronous write path.
 *
 * `Atomics.wait` on a value nobody ever notifies is the only portable way to
 * block the current thread for a fixed time in Node without an event loop turn.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether a lock file has been abandoned by a holder that is gone.
 *
 * Reuses {@link isAlive}, the same liveness test presence uses, so there is one
 * definition of "this process exists" in the module. What it deliberately does
 * *not* reuse is the boot-id / proc-identity vocabulary: those exist because a
 * registration lives for hours and a pid can be recycled in that time. A lock is
 * held for milliseconds, so there is no long window for a reuse to hide in, and
 * the age requirement below is the guard that matters — a *live* pid that merely
 * inherited the number is waited out and then reported, never treated as dead.
 */
function lockIsAbandoned(lockPath: string): boolean {
  const held = readJson<LockFile>(lockPath);
  if (held != null && isAlive(held.pid)) return false;
  // Age comes from the holder's own stamp when it is readable, and from the file
  // otherwise: a writer killed between `open` and `write` leaves an empty lock,
  // which must not be able to wedge the path forever either.
  let age: number;
  const started = held == null ? Number.NaN : Date.parse(held.startedAt);
  if (Number.isFinite(started)) {
    age = Date.now() - started;
  } else {
    try {
      age = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      // Vanished between the failed open and this stat: let the next attempt
      // take it, nobody holds it now.
      return true;
    }
  }
  return age > LOCK_STALE_MS;
}

/**
 * Run `fn` holding an exclusive lock on `<file>.lock`.
 *
 * `temp + rename` is atomic but not exclusive: two writers each read, each
 * write and the last rename wins, so one writer's update disappears without an
 * error anywhere. This holds a lock file across the read-modify-write, which is
 * the part `writeJsonAtomic` cannot do.
 *
 * The wait is bounded — a handful of short sleeps and then a thrown error
 * naming the lock path. An unbounded wait would be worse than a failed write:
 * it hangs the caller silently on every subsequent call, whereas a throw is
 * loud and names the file to remove.
 *
 * A lock left by a process that died is removed once and the acquisition retried
 * immediately, so a kill -9 mid-write costs the next writer nothing.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lockPath = `${file}.lock`;
  ensureDir(path.dirname(lockPath));
  const startedAt = new Date().toISOString();
  let staleRemovals = 0;
  let waits = 0;

  for (;;) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd != null) {
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt }, null, 2)}\n`);
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    // Exactly one attempt to clear an abandoned lock, and it does not consume
    // the wait budget: the holder it replaces is already dead.
    if (staleRemovals === 0 && lockIsAbandoned(lockPath)) {
      staleRemovals += 1;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* another writer cleared it first, or it was released normally */
      }
      continue;
    }
    waits += 1;
    if (waits > LOCK_RETRIES) {
      throw new Error(
        `Could not lock ${lockPath}: another process holds it. ` +
          `Waited ${LOCK_RETRIES} times. If the holder is gone, remove that file and retry.`,
      );
    }
    sleepSync(waits * LOCK_BACKOFF_MS);
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* released by a stale-lock recovery; the write it guarded still happened */
    }
  }
}

/** Drop undefined entries, so a patch can never write `key: undefined` over a stamp. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
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

/**
 * Merge one patch into one recipient's receipt, under a lock.
 *
 * The entry is *spread*, not reconstructed. Reconstructing erased every field
 * the writing code did not know about, which is how two receipts on this machine
 * came to record a delivery that archived but whose `deliveredAt` never
 * persisted — a sender reads that as a message that never arrived. A spread
 * keeps unknown fields from any version, including one newer than the writer.
 *
 * A known stamp is never replaced once set: `current.x ?? patch.x` is the "never
 * move a timestamp backwards" rule, and it is also what makes a repeated call
 * not new information. A patch therefore adds, and cannot blank.
 */
function recordReceipt(paths: Paths, id: string, recipient: string, patch: Partial<Receipt>): void {
  const file = receiptPath(paths, id);
  withFileLock(file, () => {
    const existing = readJson<ReceiptRecord>(file) ?? { id, receipts: {} };
    if (existing.receipts == null) existing.receipts = {};
    const current = existing.receipts[recipient] ?? ({} as Receipt);
    const merged = { ...current, ...definedOnly(patch) } as Receipt;
    merged.queuedAt = current.queuedAt ?? patch.queuedAt ?? new Date().toISOString();
    if (current.deliveredAt != null) merged.deliveredAt = current.deliveredAt;
    if (current.readAt != null) merged.readAt = current.readAt;
    existing.receipts[recipient] = merged;
    writeJsonAtomic(file, existing);
  });
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

/**
 * Record that a client rendered a message to a human.
 *
 * Only a renderer can attest this, which is why the extension does not write it:
 * `readAt` means "a screen showed these bytes", never "acted on" or "agreed
 * with". It goes through {@link recordReceipt}, so it inherits the spread and the
 * lock, and the first read wins: reading the same message twice is not new
 * information, and a second read must not reorder delivery evidence.
 */
export function markRead(paths: Paths, id: string, recipient: string, at?: string): void {
  recordReceipt(paths, id, recipient, { readAt: at ?? new Date().toISOString() });
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
  const file = path.join(roomDir(paths, room.name), "room.json");
  withFileLock(file, () => writeJsonAtomic(file, room));
}

/**
 * Add one member to a room, reading and writing under the room's lock.
 *
 * Joining is a read-modify-write of a shared file: two lanes joining at once
 * each read the old member list, each write their own, and one loses. The lock
 * spans the read for that reason — locking only the write would still let the
 * loser's member list win. Returns the room as it stands afterwards, or null when
 * the room does not exist.
 */
export function addRoomMember(paths: Paths, name: string, member: string): Room | null {
  if (!isValidRoom(name)) return null;
  const file = path.join(roomDir(paths, name), "room.json");
  return withFileLock(file, () => {
    const room = readJson<Room>(file);
    if (room == null) return null;
    if (!room.members.includes(member)) {
      room.members = uniqueMembers([...room.members, member]);
      writeJsonAtomic(file, room);
    }
    return room;
  });
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
