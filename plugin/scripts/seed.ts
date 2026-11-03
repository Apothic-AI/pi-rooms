/**
 * A seeding script for manual review and for the screenshot in the report.
 *
 * It writes with the store's own functions, which is the same thing `bin/rooms`
 * does, so what the popup reads is a real store and not a fixture that happens
 * to match the renderer.
 *
 * Usage: node --experimental-strip-types plugin/scripts/seed.ts /tmp/somewhere
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  appendPost,
  archive,
  createParticipant,
  createRoom,
  deliver,
  drain,
  markDelivered,
  markRead,
  readPosts,
  resolvePaths,
  writePresence,
} from "../../src/store.ts";

const base = process.argv[2];
if (base == null) {
  process.stderr.write("usage: seed.ts <dir>\n");
  process.exit(2);
}
fs.mkdirSync(base, { recursive: true });
const paths = resolvePaths(base);
const token = createHash("sha256").update("seed-token", "utf8").digest("hex");

const OPERATOR = "operator";
const LEADER = "pi-rooms-leader";
const WORKER = "c2-worker";

createParticipant(paths, {
  name: OPERATOR,
  kind: "human",
  displayName: "Alex",
  createdBy: LEADER,
  client: { id: "popup", label: "rooms-popup", tokenSha256: token },
});
createParticipant(paths, {
  name: "sam",
  kind: "human",
  displayName: "Sam Whitfield",
  createdBy: LEADER,
  client: { id: "tui", label: "rooms-tui", tokenSha256: token },
});

createRoom(paths, {
  name: "slice-one",
  members: [OPERATOR, LEADER, WORKER],
  createdBy: LEADER,
  createdAt: "2026-11-02T18:00:00.000Z",
});
createRoom(paths, {
  name: "beads-integration-r2",
  members: [LEADER, WORKER],
  createdBy: LEADER,
  createdAt: "2026-11-02T18:05:00.000Z",
});

const posts: Array<[string, string, string]> = [
  [LEADER, "slice-one", "Slice 1 is live: bin/rooms is the writer a human uses, and it imports src/store.ts rather than re-implementing it."],
  [WORKER, "slice-one", "Read --follow is in. It emits NDJSON, never passes a limit, and says a gap out loud instead of resequencing."],
  [LEADER, "slice-one", "The receipt rule is the one to keep in front of you: when a receipt has no deliveredAt but inbox/<name>/read/<id>.json exists, the copy is the witness. It is stamped earlier and written before markDelivered, so it is the record the receipt can lose.\n\nA client that reads absence as 'not delivered' re-sends mail that already arrived."],
  [WORKER, "slice-one", "Presence is a lease with a timestamp, so the popup renders 'away · declared 23m ago' and never a filled dot."],
  [LEADER, "beads-integration-r2", "swarm-vwr is the split where .pi/ is untracked and AGENTS.md is a symlink. It is the repo owner's call, not a worker's."],
];

const ids: Array<{ id: string; room: string }> = [];
for (const [from, room, text] of posts) {
  const id = randomUUID();
  const seq = appendPost(paths, room, {
    id,
    from,
    text,
    sentAt: new Date(Date.parse("2026-11-02T19:00:00.000Z") + ids.length * 240_000).toISOString(),
    recipients: [],
    via: "agent",
    client: "pi-rooms",
  });
  ids.push({ id, room });
  void seq;
}

// A DM that reached the operator's inbox and was archived: the copy is the
// witness, and its receipt deliberately has no deliveredAt.
const landed = randomUUID();
deliver(paths, {
  id: landed,
  from: LEADER,
  to: [OPERATOR],
  text: "The popup is linked. Press prefix+shift+r and tell me what you see — the inbox row should read 'delivered · copy', not 'queued'.",
  sentAt: "2026-11-02T21:40:00.000Z",
  via: "agent",
  client: "pi-rooms",
});
const pending = drain(paths, OPERATOR);
for (const { file, message } of pending) archive(paths, OPERATOR, file, message);
// Rewrite the receipt without deliveredAt, to reproduce the exact disagreement
// the copy-witness rule exists for.
const receiptFile = path.join(paths.receipts, `${landed}.json`);
const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
delete receipt.receipts[OPERATOR].deliveredAt;
fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));

// A DM still sitting in the inbox: queued, nothing has observed it.
deliver(paths, {
  id: randomUUID(),
  from: WORKER,
  to: [OPERATOR],
  text: "Second one is still in the box so the queued state has something to show.",
  sentAt: "2026-11-02T21:58:00.000Z",
  via: "cli",
  client: "rooms-cli",
});

// A read message: readAt present.
const acked = randomUUID();
deliver(paths, {
  id: acked,
  from: LEADER,
  to: [OPERATOR],
  text: "This one was acknowledged, so it shows 'read' and the receipt carries readAt.",
  sentAt: "2026-11-02T20:10:00.000Z",
});
for (const { file, message } of drain(paths, OPERATOR)) {
  if (message.id === acked) archive(paths, OPERATOR, file, message);
}
markRead(paths, acked, OPERATOR, "2026-11-02T20:12:00.000Z");

// Presence: one live lease, one stale, one absent.
const now = Date.parse("2026-11-02T22:00:00.000Z");
writePresence(paths, {
  name: OPERATOR,
  state: "online",
  lastSeenAt: new Date(now).toISOString(),
  leaseUntil: new Date(now + 60_000).toISOString(),
  client: "rooms-popup",
  note: null,
});

process.stdout.write(
  `${JSON.stringify(
    {
      base,
      rooms: ["slice-one", "beads-integration-r2"],
      posts: readPosts(paths, "slice-one", 0, 1000).length,
      operatorMail: drain(paths, OPERATOR).length,
      receiptWithoutDeliveredAt: receiptFile,
    },
    null,
    2,
  )}\n`,
);
