/**
 * A throwaway store, built through the real store functions.
 *
 * Every web test runs against one of these, named by `PI_ROOMS_DIR`. Nothing
 * here may touch `~/.pi/agent/rooms` — that is where the live fleet talks, and a
 * client test that needed it would be a test of the wrong thing. `tempStore()`
 * returns both the paths and a `checkNoLiveStore()` guard, so the claim is
 * checkable rather than a comment.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendPost,
  archive,
  createParticipant,
  createRoom,
  deliver,
  markDelivered,
  markRead,
  resolvePaths,
  writePresence,
  type Paths,
} from "../../src/store.ts";

export const OPERATOR = "operator";
export const AGENT = "fixture-agent";
export const OTHER = "fixture-other";
export const ROOM = "web-fixture";
export const EMPTY_ROOM = "web-empty";
export const TOKEN = "fixture-token";

export interface TempStore {
  base: string;
  paths: Paths;
  cleanup(): void;
}

export function tempStore(): TempStore {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-web-"));
  const paths = resolvePaths(base);
  for (const dir of [paths.registry, paths.inbox, paths.rooms, paths.receipts, paths.participants, paths.presence]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    base,
    paths,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Refuse to run if `PI_ROOMS_DIR` is unset or points at the live store.
 *
 * Called at the top of every test that starts a server: the server reads
 * `PI_ROOMS_DIR` from its own environment, so a forgotten override would point
 * the whole suite at the fleet's real rooms.
 */
export function assertNotLiveStore(base: string): void {
  const live = path.join(os.homedir(), ".pi", "agent", "rooms");
  if (path.resolve(base) === path.resolve(live)) {
    throw new Error(`refusing to run a test against the live store at ${live}`);
  }
}

function iso(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

/**
 * Build the fixture.
 *
 * The receipt ladder is built in its four states on purpose, because the
 * `unknown` rung is the one a naive client gets wrong:
 *
 *   - `#1` **queued** — envelope delivered, no `deliveredAt` anywhere
 *   - `#2` **delivered** — `markDelivered` ran, so the receipt carries the stamp
 *   - `#3` **delivered via the read-copy witness** — archived, but the receipt's
 *     `deliveredAt` was *lost*, which is the exact §5.3 case: the copy is the
 *     witness and the state is still `delivered`, never "not delivered"
 *   - `#4` **unknown** — a post whose receipt file does not exist at all
 *   - `#5` **read** — a DM the operator acknowledged with `markRead`
 */
export function seed(store: TempStore): { queuedId: string; deliveredId: string; witnessId: string; unknownId: string; readId: string } {
  const { paths } = store;

  // The operator carries a client token because the CLI is fail-closed about it:
  // a participant record with no `tokenSha256` refuses every invocation, which is
  // the store's rule and not something a test may bypass. The deliberate-write
  // test needs a *working* writer so it can prove the write detector is sensitive.
  createParticipant(paths, {
    name: OPERATOR,
    kind: "human",
    displayName: "The Operator",
    createdBy: OPERATOR,
    createdAt: iso(600_000),
    client: {
      id: "fixture-client",
      label: "fixture",
      tokenSha256: createHash("sha256").update(TOKEN, "utf8").digest("hex"),
    },
  });
  createParticipant(paths, { name: AGENT, kind: "agent", createdBy: OPERATOR, createdAt: iso(600_000) });
  createParticipant(paths, { name: OTHER, kind: "human", createdBy: OPERATOR, createdAt: iso(600_000) });

  createRoom(paths, { name: ROOM, members: [OPERATOR, AGENT, OTHER], createdBy: AGENT, createdAt: iso(600_000) });
  // A room with no posts, so the empty state is a real store state and not a
  // fixture that failed to build.
  createRoom(paths, { name: EMPTY_ROOM, members: [OPERATOR, AGENT], createdBy: AGENT, createdAt: iso(600_000) });

  // Presence: one of each of the four words, all written as leases.
  writePresence(paths, { name: OPERATOR, state: "online", lastSeenAt: iso(0), leaseUntil: new Date(Date.now() + 60_000).toISOString(), client: "fixture" });
  writePresence(paths, { name: AGENT, state: "online", lastSeenAt: iso(23 * 60_000), leaseUntil: iso(22 * 60_000), client: "fixture" });
  // OTHER has no presence record at all: the `unknown` word, which must not look
  // like `offline`.

  const now = Date.now();
  const post = (seq: number, from: string, text: string) => {
    const id = `1111111${seq}-0000-4000-8000-00000000000${seq}`;
    appendPost(paths, ROOM, { id, from, text, sentAt: new Date(now - (6 - seq) * 60_000).toISOString(), recipients: [OPERATOR, AGENT, OTHER].filter((m) => m !== from), via: "cli", client: "fixture" });
    return id;
  };

  // #1 queued: delivered to inboxes, never marked delivered.
  const queuedId = post(1, AGENT, "First line of the fixture: the receipt is queued and nothing more.");
  deliver(paths, { id: queuedId, from: AGENT, to: [OPERATOR, OTHER], text: "First line of the fixture: the receipt is queued and nothing more.", sentAt: new Date(now - 5 * 60_000).toISOString(), room: ROOM, roomSeq: 1, via: "cli" });

  // #2 delivered: the real archive path, which renames and stamps.
  const deliveredId = post(2, AGENT, "Second line: archived through the store's own path, so deliveredAt exists.");
  deliver(paths, { id: deliveredId, from: AGENT, to: [OPERATOR], text: "Second line: archived through the store's own path, so deliveredAt exists.", sentAt: new Date(now - 4 * 60_000).toISOString(), room: ROOM, roomSeq: 2, via: "cli" });
  const deliveredFile = findPending(paths, OPERATOR, deliveredId);
  if (deliveredFile != null) archive(paths, OPERATOR, deliveredFile, readEnvelope(deliveredFile));

  // #3 the witness case: archived, then the receipt's deliveredAt is removed,
  // exactly as a crash between the copy-write and markDelivered would leave it.
  const witnessId = post(3, AGENT, "Third line: the receipt lost its deliveredAt, and the inbox copy is the witness.");
  deliver(paths, { id: witnessId, from: AGENT, to: [OPERATOR], text: "Third line: the receipt lost its deliveredAt, and the inbox copy is the witness.", sentAt: new Date(now - 3 * 60_000).toISOString(), room: ROOM, roomSeq: 3, via: "cli" });
  const witnessFile = findPending(paths, OPERATOR, witnessId);
  if (witnessFile != null) archive(paths, OPERATOR, witnessFile, readEnvelope(witnessFile));
  const receiptPath = path.join(paths.receipts, `${witnessId}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  delete receipt.receipts[OPERATOR].deliveredAt;
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

  // #4 unknown: a post with no receipt file and no inbox copy at all.
  const unknownId = post(4, OTHER, "Fourth line: no receipt file exists for this one, so its delivery is unknown.");

  // #5 a DM the operator acked, so `read` is on the ladder and readAt is real.
  const readId = "99999999-0000-4000-8000-000000000099";
  deliver(paths, { id: readId, from: AGENT, to: [OPERATOR], text: "A direct message the operator acknowledged.", sentAt: new Date(now - 2 * 60_000).toISOString(), via: "cli" });
  const dmFile = findPending(paths, OPERATOR, readId);
  if (dmFile != null) {
    archive(paths, OPERATOR, dmFile, readEnvelope(dmFile));
    markDelivered(paths, readId, OPERATOR);
    markRead(paths, readId, OPERATOR, iso(60_000));
  }

  // A second delivered DM left *pending*, so the inbox route has something in
  // `dir: pending` and the undrained claim is testable.
  const pendingId = "99999999-0000-4000-8000-0000000000aa";
  deliver(paths, { id: pendingId, from: OPERATOR, to: [OTHER], text: "An outbound DM, still pending in the recipient's inbox.", sentAt: new Date(now - 60_000).toISOString(), via: "cli" });
  deliver(paths, { id: "99999999-0000-4000-8000-0000000000bb", from: AGENT, to: [OPERATOR], text: "A DM still sitting pending in the operator's inbox.", sentAt: new Date(now - 30_000).toISOString(), via: "cli" });

  return { queuedId, deliveredId, witnessId, unknownId, readId };
}

function findPending(paths: Paths, name: string, id: string): string | null {
  const dir = path.join(paths.inbox, name);
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(dir, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (parsed.id === id) return full;
    } catch {
      /* skip */
    }
  }
  return null;
}

function readEnvelope(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/* ── Snapshot: every file under a store, by content hash ──────────────────── */

export interface SnapshotEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * Every file under `root`, with its content hash and mtime.
 *
 * mtime as well as hash: a rewrite with identical bytes is still a write, and
 * the write-nothing claim is about the store not being touched, not about it
 * ending up with the same contents.
 */
export function snapshot(root: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(full);
      out.push({
        rel: path.relative(root, full),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
      });
    }
  };
  walk(root);
  return out;
}

/** Paths that differ between two snapshots, in either direction. */
export function snapshotDiff(before: SnapshotEntry[], after: SnapshotEntry[]): string[] {
  const beforeMap = new Map(before.map((e) => [e.rel, e]));
  const afterMap = new Map(after.map((e) => [e.rel, e]));
  const diffs: string[] = [];
  for (const [rel, entry] of beforeMap) {
    const now = afterMap.get(rel);
    if (now == null) diffs.push(`removed: ${rel}`);
    else if (now.sha256 !== entry.sha256) diffs.push(`content changed: ${rel}`);
    else if (now.mtimeMs !== entry.mtimeMs) diffs.push(`mtime changed: ${rel}`);
  }
  for (const rel of afterMap.keys()) {
    if (!beforeMap.has(rel)) diffs.push(`created: ${rel}`);
  }
  return diffs;
}
