/**
 * Read-only access to the store, for the popup.
 *
 * **This module never writes.** Not one `fs` mutator and not one store function
 * that mutates — that is a claim a test asserts against the source text, because
 * the failure it prevents (a renderer that stamps `readAt` on paint) is silent
 * and destroys the only evidence this run exists to protect.
 *
 * Two store functions are avoided on purpose:
 *
 *   `listAgents`   unlinks registrations it considers dead.
 *   `readRoster`   unlinks registrations it cannot parse.
 *
 * `drain` is avoided for the same reason — it deletes an unparseable envelope
 * from the inbox. The inbox is read here by plain `readdir` + `JSON.parse`, so a
 * malformed file stays on disk for its owner to see rather than vanishing at the
 * hand of a viewer.
 *
 * The delivery ladder in {@link readInbox} is the single most important rule in
 * the plugin: when a receipt has no `deliveredAt` but the archived copy in
 * `inbox/<name>/read/` exists, **the copy is the witness** — it is stamped
 * earlier and written before `markDelivered`, so it is the record a receipt can
 * lose. Reading that as "not delivered" makes a client re-send mail that already
 * arrived.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  listParticipants,
  listRooms,
  readPosts,
  readPresence,
  readReceipts,
  resolveBase,
  resolvePaths,
  type Delivery,
  type Paths,
  type PresenceView,
  type Room,
} from "../../src/store.ts";

/** The four words a message may be described with. There is no fifth. */
export type DeliveryState = "queued" | "delivered" | "read" | "unknown";

export interface MailItem {
  id: string;
  from: string;
  to: string[];
  sentAt: string;
  text: string;
  room: string | null;
  roomSeq: number | null;
  state: DeliveryState;
  /** What moved it past `queued`: a receipt stamp, or the archived copy. */
  witness: "receipt" | "copy" | null;
  readAt: string | null;
  deliveredAt: string | null;
  queuedAt: string | null;
  via: string | null;
}

export interface RoomSummary {
  room: Room;
  posts: number;
}

export interface HumanRow {
  name: string;
  displayName: string | null;
  presence: PresenceView;
}

export interface Snapshot {
  base: string;
  rooms: RoomSummary[];
  humans: HumanRow[];
  inbox: MailItem[];
  /** A read that failed, named. A blank pane would be indistinguishable from an empty store. */
  error: string | null;
  errorCause: string | null;
  takenAt: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function storePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  return resolvePaths(resolveBase(env));
}

/**
 * The ladder, in one place.
 *
 * `readAt` is only ever written by `rooms ack`, so its absence means *nobody has
 * acknowledged this*, not that the message failed. `deliveredAt` can be missing
 * from a receipt that the archived copy proves — that is the copy-witness rule,
 * and it is why `hasCopy` is checked before concluding anything from a stamp's
 * absence.
 */
export function ladder(input: {
  readAt: string | null;
  deliveredAt: string | null;
  hasCopy: boolean;
  hasPending: boolean;
}): { state: DeliveryState; witness: "receipt" | "copy" | null } {
  if (input.readAt != null) return { state: "read", witness: "receipt" };
  if (input.deliveredAt != null) return { state: "delivered", witness: "receipt" };
  if (input.hasCopy) return { state: "delivered", witness: "copy" };
  if (input.hasPending) return { state: "queued", witness: null };
  return { state: "unknown", witness: null };
}

/**
 * One name's mail, pending and archived, as a reader sees it.
 *
 * Pending and archived copies are de-duplicated by id, and the archived copy
 * wins: it is the one stamped at handover, and the pending file for the same id
 * can outlive the archive on a filesystem where the rename failed.
 */
export function readInbox(paths: Paths, name: string): MailItem[] {
  const dir = path.join(paths.inbox, name);
  const readDir = path.join(dir, "read");
  const archived = new Set<string>();
  const items = new Map<string, MailItem>();

  for (const file of safeReaddir(readDir)) {
    if (!file.endsWith(".json")) continue;
    const message = readJson<Delivery>(path.join(readDir, file));
    if (message == null || typeof message.id !== "string") continue;
    archived.add(message.id);
    items.set(message.id, toItem(paths, name, message, true, false));
  }

  for (const file of safeReaddir(dir)) {
    if (!file.endsWith(".json")) continue;
    const message = readJson<Delivery>(path.join(dir, file));
    if (message == null || typeof message.id !== "string") continue;
    if (items.has(message.id)) continue;
    items.set(message.id, toItem(paths, name, message, false, true));
  }

  return [...items.values()].sort((a, b) => {
    const at = Date.parse(a.sentAt);
    const bt = Date.parse(b.sentAt);
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
}

function toItem(
  paths: Paths,
  name: string,
  message: Delivery,
  hasCopy: boolean,
  hasPending: boolean,
): MailItem {
  const receipt = readReceipts(paths, message.id)?.receipts?.[name] ?? null;
  const readAt = typeof receipt?.readAt === "string" ? receipt.readAt : null;
  const deliveredAt = typeof receipt?.deliveredAt === "string" ? receipt.deliveredAt : null;
  const { state, witness } = ladder({ readAt, deliveredAt, hasCopy, hasPending });
  return {
    id: message.id,
    from: typeof message.from === "string" ? message.from : "(unknown sender)",
    to: Array.isArray(message.to) ? message.to.filter((t) => typeof t === "string") : [],
    sentAt: typeof message.sentAt === "string" ? message.sentAt : "",
    text: typeof message.text === "string" ? message.text : "",
    room: typeof message.room === "string" ? message.room : null,
    roomSeq: typeof message.roomSeq === "number" ? message.roomSeq : null,
    state,
    witness,
    readAt,
    deliveredAt,
    queuedAt: typeof receipt?.queuedAt === "string" ? receipt.queuedAt : null,
    via: typeof message.via === "string" ? message.via : null,
  };
}

/** Every room with its post count, and every human with its *derived* presence. */
export function readSnapshot(env: NodeJS.ProcessEnv, identity: string | null, now = Date.now()): Snapshot {
  let paths: Paths;
  try {
    paths = storePaths(env);
  } catch (error) {
    return {
      base: "(unresolved)",
      rooms: [],
      humans: [],
      inbox: [],
      error: "the store root could not be resolved",
      errorCause: (error as Error)?.message ?? String(error),
      takenAt: now,
    };
  }

  let rooms: RoomSummary[];
  let humans: HumanRow[];
  let inbox: MailItem[] = [];
  try {
    rooms = listRooms(paths).map((room) => ({ room, posts: readPosts(paths, room.name, 0, Number.MAX_SAFE_INTEGER).length }));
    humans = listParticipants(paths).map((participant) => ({
      name: participant.name,
      displayName: participant.displayName ?? null,
      presence: readPresence(paths, participant.name, now),
    }));
    if (identity != null) inbox = readInbox(paths, identity);
  } catch (error) {
    return {
      base: paths.base,
      rooms: [],
      humans: [],
      inbox: [],
      error: "the store could not be read",
      errorCause: (error as Error)?.message ?? String(error),
      takenAt: now,
    };
  }

  return { base: paths.base, rooms, humans, inbox, error: null, errorCause: null, takenAt: now };
}

/** One room's history as numbered posts. Read-only; `readPosts` never writes. */
export function readRoomHistory(paths: Paths, room: string) {
  return readPosts(paths, room, 0, Number.MAX_SAFE_INTEGER);
}
