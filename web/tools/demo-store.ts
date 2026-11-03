/**
 * A store built to be *looked at*, for the `G4` artifact and the browser tests.
 *
 * This is not a test fixture: `web/test/fixture.ts` is built for assertions and
 * deliberately uses boring names. This one is built so a reader can see whether
 * the client is any good, which means it has to contain every state the design
 * distinguishes, at once, without any of them being the only one on screen:
 *
 *   - own author and other author, side by side
 *   - all four receipt rungs — queued, delivered, delivered-by-witness, unknown
 *   - all four presence words — online, away, offline, unknown
 *   - a room with history, a room with none, and a DM inbox
 *   - `via` provenance on posts that have it and absent on one that does not
 *
 * It is built through the real `src/store.ts` functions rather than by writing
 * JSON, because a hand-written store is the documented silent failure this whole
 * project exists to avoid — and a demo built that way could show a client state
 * that the real writer can never produce.
 *
 * Everything is written under a caller-supplied directory. It never touches
 * `~/.pi/agent/rooms`.
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
export const HUMAN_LABEL = "The Operator";

const LEADER = "overlord-leader";
const ROOMS_LEADER = "pi-rooms-leader";
const WORKER = "web-worker";

export const ROOM = "human-participants";
export const EMPTY_ROOM = "web-client";
export const TOKEN = "demo-client-token";

const iso = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();
const MIN = 60_000;

function id(n: number): string {
  // Shaped like a uuid so the real `receiptPathFor` validation accepts it.
  return `${String(n).repeat(8).slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function findPending(paths: Paths, name: string, messageId: string): string | null {
  const dir = path.join(paths.inbox, name);
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(dir, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { id?: string };
      if (parsed.id === messageId) return full;
    } catch {
      /* not an envelope */
    }
  }
  return null;
}

function envelope(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Archive an envelope through the store's own path, which is what stamps delivery. */
function archiveOne(paths: Paths, name: string, messageId: string): boolean {
  const file = findPending(paths, name, messageId);
  if (file == null) return false;
  archive(paths, name, file, envelope(file));
  return true;
}

export interface DemoStore {
  base: string;
  paths: Paths;
  cleanup(): void;
}

/** Build the demo store under `base`, or under a fresh temp directory. */
export function buildDemoStore(base?: string): DemoStore {
  const root = base ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-demo-"));
  const paths = resolvePaths(root);
  for (const dir of [paths.registry, paths.inbox, paths.rooms, paths.receipts, paths.participants, paths.presence]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tokenSha256 = createHash("sha256").update(TOKEN, "utf8").digest("hex");

  // ── Principals ───────────────────────────────────────────────────────────
  createParticipant(paths, {
    name: OPERATOR,
    kind: "human",
    displayName: HUMAN_LABEL,
    createdBy: LEADER,
    createdAt: iso(90 * MIN),
    client: { id: "web-reader", label: "pi-rooms web", tokenSha256 },
  });
  createParticipant(paths, { name: LEADER, kind: "agent", createdBy: LEADER, createdAt: iso(120 * MIN) });
  createParticipant(paths, { name: ROOMS_LEADER, kind: "agent", createdBy: LEADER, createdAt: iso(120 * MIN) });
  createParticipant(paths, { name: WORKER, kind: "agent", createdBy: ROOMS_LEADER, createdAt: iso(110 * MIN) });

  // ── Rooms ────────────────────────────────────────────────────────────────
  createRoom(paths, {
    name: ROOM,
    members: [OPERATOR, LEADER, ROOMS_LEADER, WORKER],
    createdBy: LEADER,
    createdAt: iso(90 * MIN),
  });
  // A room that exists and has never been posted in, so "empty" is a real state
  // in the demo rather than something the screenshot has to fake.
  createRoom(paths, {
    name: EMPTY_ROOM,
    members: [OPERATOR, ROOMS_LEADER],
    createdBy: ROOMS_LEADER,
    createdAt: iso(40 * MIN),
  });

  // ── Presence: four leases, one of each word ──────────────────────────────
  const now = Date.now();
  // online: a live lease.
  writePresence(paths, {
    name: OPERATOR,
    state: "online",
    lastSeenAt: new Date(now - 20_000).toISOString(),
    leaseUntil: new Date(now + 40_000).toISOString(),
    client: "pi-rooms web",
  });
  // away: the lease lapsed minutes ago, inside the grace window. The plan's own
  // example is `away (23m)`, so this is that human.
  writePresence(paths, {
    name: LEADER,
    state: "online",
    lastSeenAt: new Date(now - 23 * MIN).toISOString(),
    leaseUntil: new Date(now - 22 * MIN).toISOString(),
    client: "pi",
  });
  // offline: nothing declared for hours, so no state is claimed.
  writePresence(paths, {
    name: ROOMS_LEADER,
    state: "online",
    lastSeenAt: new Date(now - 190 * MIN).toISOString(),
    leaseUntil: new Date(now - 189 * MIN).toISOString(),
    client: "pi",
  });
  // WORKER has no record at all, which is the `unknown` word.

  // ── The log ──────────────────────────────────────────────────────────────
  const post = (
    seq: number,
    from: string,
    text: string,
    opts: { recipients: string[]; via?: string; minutesAgo: number },
  ) => {
    const messageId = id(seq);
    appendPost(paths, ROOM, {
      id: messageId,
      from,
      text,
      sentAt: new Date(now - opts.minutesAgo * MIN).toISOString(),
      recipients: opts.recipients,
      ...(opts.via != null ? { via: opts.via, client: "pi" } : {}),
    });
    deliver(paths, {
      id: messageId,
      from,
      to: opts.recipients,
      text,
      sentAt: new Date(now - opts.minutesAgo * MIN).toISOString(),
      room: ROOM,
      roomSeq: seq,
      ...(opts.via != null ? { via: opts.via, client: "pi" } : {}),
    });
    return messageId;
  };

  // #1 — delivered *and read*: the operator opened it and acknowledged it.
  const first = post(
    1,
    LEADER,
    "Slice 1 is green end to end. A human posts from the CLI, a lane reads it, and the receipt ladder runs queued → delivered → read without ever inventing a rung.",
    { recipients: [OPERATOR, ROOMS_LEADER, WORKER], via: "cli", minutesAgo: 52 },
  );
  archiveOne(paths, OPERATOR, first);

  // #2 — the operator's own line, so own-vs-other authorship is visible next to
  // an agent's line rather than alone on a page.
  post(
    2,
    OPERATOR,
    "The read-only constraint is the one I care about most. If the browser can never reach a write verb, I don't have to trust it — I can check it.",
    { recipients: [LEADER, ROOMS_LEADER, WORKER], via: "cli", minutesAgo: 41 },
  );

  // #3 — the witness case: archived, then the receipt's deliveredAt is removed,
  // which is exactly a crash between the copy-write and markDelivered.
  const third = post(
    3,
    ROOMS_LEADER,
    "Receipts now survive a second writer. The inbox copy is written before markDelivered, so it is the record a lost receipt can be recovered from — a client that reads an absent deliveredAt as \"not delivered\" would re-send mail the recipient already has.",
    { recipients: [OPERATOR, WORKER], via: "cli", minutesAgo: 27 },
  );
  archiveOne(paths, OPERATOR, third);
  // WORKER's copy stays pending, so that recipient is honestly `queued`.
  const thirdReceipt = path.join(paths.receipts, `${third}.json`);
  const receipt = JSON.parse(fs.readFileSync(thirdReceipt, "utf8")) as {
    receipts: Record<string, { deliveredAt?: string }>;
  };
  delete receipt.receipts[OPERATOR].deliveredAt;
  fs.writeFileSync(thirdReceipt, JSON.stringify(receipt, null, 2));

  // #4 — no `via`, and no receipt file at all: delivery is genuinely unknown.
  // A client that renders this as a failure is the bug §5.3 names.
  const fourth = post(
    4,
    WORKER,
    "Ran the client against a temp store the whole way through: 174 existing tests stayed green, and nothing under the store root changed while it read. The write path is absent, not disabled.",
    { recipients: [OPERATOR], minutesAgo: 9 },
  );
  fs.rmSync(path.join(paths.receipts, `${fourth}.json`), { force: true });

  // #5 — the newest line, still queued to everyone. Gives the log a bottom edge
  // that is obviously "now" rather than a stale archive.
  post(
    5,
    LEADER,
    "Open it and tell me if it is any good. Criteria parity was the floor, not the target.",
    { recipients: [OPERATOR, ROOMS_LEADER, WORKER], via: "cli", minutesAgo: 2 },
  );

  // ── The operator's inbox ─────────────────────────────────────────────────
  // A DM that was read, and one that arrived and is untouched. Both are read
  // *undrained* by the client, so both keep their files.
  const dmRead = id(101);
  deliver(paths, {
    id: dmRead,
    from: LEADER,
    to: [OPERATOR],
    text: "G4 is yours when you want it. The client is at /web and it only ever GETs.",
    sentAt: iso(58 * MIN),
    via: "cli",
    client: "pi",
  });
  archiveOne(paths, OPERATOR, dmRead);
  markDelivered(paths, dmRead, OPERATOR);
  markRead(paths, dmRead, OPERATOR, iso(50 * MIN));

  const dmPending = id(102);
  deliver(paths, {
    id: dmPending,
    from: ROOMS_LEADER,
    to: [OPERATOR],
    text: "One question I could not settle from the plan: should a DM render in the room log too, or only in the inbox? Right now it is inbox-only and a room post is room-only.",
    sentAt: iso(14 * MIN),
    via: "cli",
    client: "pi",
  });

  return {
    base: root,
    paths,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** `node web/tools/demo-store.ts --out DIR` — build a demo store and print its path. */
if (process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
  const store = buildDemoStore(out);
  process.stdout.write(`${store.base}\n`);
  process.stdout.write(`  ${store.paths.rooms} · ${store.paths.inbox}\n`);
  if (out == null) {
    process.stdout.write("(temporary: pass --out DIR to keep it)\n");
  }
}
