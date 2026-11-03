/**
 * Slice 1 end-to-end — plan §7, mechanised.
 *
 * This file proves the *mechanism* around the three steps a human must perform.
 * It deliberately does not, and cannot, prove that a human spoke: `from`, `via`
 * and `client` are self-declared (plan §2.2), so an agent running
 * `bin/rooms --as operator` produces every artifact "the operator posted" would
 * produce. `G3b` is the operator's gate and belongs in the operator's shell.
 *
 * What is checkable here is everything else, and each test below asserts an
 * artifact rather than an exit code wherever the failure mode is silence:
 *
 *   1. a throwaway room exists with `operator` in `members`
 *   2. `uniqueMembers` does not eject the human on the `room.json` rewrite path
 *   3. one DM each way, through **different writers**, and the CLI refuses the
 *      agent-side direction (§2.3's write-scope line, made executable)
 *   4. the receipt ladder, which differs per direction, and `readAt` only from
 *      `ack` — never from delivery or a plain read
 *   5. the post line joins to its envelope and its receipt
 *   6. the CLI holds no filesystem write of its own, and the store's writes to
 *      receipts, `room.json` and `names.json` are all under `withFileLock`
 *
 * Every test runs against a `mkdtemp` store named by `PI_ROOMS_DIR`. Nothing
 * here may touch `~/.pi/agent/rooms`: that is where the live fleet talks, and a
 * test that needed it would be a test of the wrong thing. The first test is the
 * guard that makes that claim checkable rather than a comment.
 *
 * The CLI is driven as a child process, not by calling store functions, because
 * the point of a "writer a human uses" is the process a human runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addRoomMember,
  archive,
  bootId,
  createParticipant,
  createRoom,
  deliver,
  drain,
  isValidName,
  isValidRoom,
  markDelivered,
  procIdentity,
  readParticipant,
  readPosts,
  readReceipts,
  readRoom,
  register,
  resolveBase,
  resolvePaths,
  uniqueMembers,
  type Delivery,
  type Paths,
  type Room,
} from "../src/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "rooms");

/** The human's name. Fixed by plan §11 row 1; it is a valid `NAME_RE` name. */
const OPERATOR = "operator";
/** The lane. Has a live registration and no participant record, as every lane does. */
const AGENT = "slice-agent";
/** A name with neither a record nor a registration: the participant-record refusal. */
const NEWCOMER = "latecomer";
/** The throwaway room. Not a live room, and created only in a temp store. */
const ROOM = "slice-one";

const TOKEN = "slice1-client-token";
const TOKEN_SHA = createHash("sha256").update(TOKEN, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

/**
 * Run `bin/rooms` as a child process against `base`.
 *
 * `PI_ROOMS_CLIENT_TOKEN` is cleared first so an ambient token in the operator's
 * shell can never make a token test pass by accident — the same reason
 * `cli.test.ts` does it.
 */
function rooms(base: string, args: string[], extra: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_ROOMS_DIR: base, PI_ROOMS_CLIENT_TOKEN: "", ...extra },
  });
  const stdout = result.stdout ?? "";
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { status: result.status, stdout, stderr: result.stderr ?? "", json };
}

/**
 * The CLI as the human, with the human's token.
 *
 * `--as operator` is injected after the verb unless the call already names an
 * identity, because every verb that writes requires one and no verb guesses —
 * which is itself the rule that stops a human's shell posting in a lane's voice.
 */
function asOperator(base: string, args: string[]): Run {
  if (args.length === 0) return rooms(base, args, { PI_ROOMS_CLIENT_TOKEN: TOKEN });
  const withIdentity = args.includes("--as") ? args : [args[0], "--as", OPERATOR, ...args.slice(1)];
  return rooms(base, withIdentity, { PI_ROOMS_CLIENT_TOKEN: TOKEN });
}

interface Seeded {
  paths: Paths;
  base: string;
}

/**
 * A temp store holding the slice-1 scenario: a human with a participant record,
 * a throwaway room with both names in it, and a lane registered to *this* test
 * process so `isRegistrationLive` is true without spawning anything.
 *
 * Registering the agent to this pid is what makes the "refuse to write as a
 * lane" assertion real: the rule is about a name a running process holds, and
 * this process is running. A fake pid would test the wrong branch.
 */
function seeded(): Seeded {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-slice1-"));
  const paths = resolvePaths(base);

  createParticipant(paths, {
    name: OPERATOR,
    kind: "human",
    displayName: "Operator",
    createdBy: AGENT,
    client: { id: "rooms-cli", label: "rooms-cli", tokenSha256: TOKEN_SHA },
  });

  createRoom(paths, {
    name: ROOM,
    members: [OPERATOR, AGENT],
    createdBy: AGENT,
    createdAt: new Date().toISOString(),
  });

  const stamp = new Date().toISOString();
  register(paths, {
    name: AGENT,
    pid: process.pid,
    cwd: "/work/slice1",
    startedAt: stamp,
    updatedAt: stamp,
    procId: procIdentity(process.pid) ?? undefined,
    bootId: bootId() ?? undefined,
  });

  return { paths, base };
}

function roomFile(paths: Paths): string {
  return path.join(paths.rooms, ROOM, "room.json");
}

function logLines(paths: Paths): any[] {
  const raw = fs.readFileSync(path.join(paths.rooms, ROOM, "log.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** The agent's mailbox, as a lane reads it: `drain` plus the file each copy lives in. */
function inbox(paths: Paths, name: string): Array<{ file: string; message: Delivery }> {
  return drain(paths, name);
}

// ---------------------------------------------------------------------------
// The guard — nothing below may touch the live store
// ---------------------------------------------------------------------------

test("the harness writes only to a temp store, and the live store is untouched", () => {
  const { base } = seeded();

  // The claim the whole file rests on: with no override the store is the live
  // fleet store, so every call above and below must name a different one.
  const live = resolveBase({});
  assert.ok(live.endsWith(path.join(".pi", "agent", "rooms")), `live store is ${live}`);
  assert.notEqual(base, live, "a test store is never the live store");
  assert.ok(
    path.resolve(base).startsWith(path.resolve(os.tmpdir())),
    `${base} is under the temp directory`,
  );

  // And the child process really honours it: a verb that writes must land under
  // the temp base rather than in the live store.
  const run = asOperator(base, ["dm", "--to", AGENT, "guard", "check"]);
  assert.equal(run.status, 0, run.stderr);
  const id = run.stdout.match(/id ([0-9a-f-]{36})/)?.[1];
  assert.ok(id != null, run.stdout);
  assert.ok(
    fs.existsSync(path.join(base, "receipts", `${id}.json`)),
    "the receipt is under PI_ROOMS_DIR",
  );
});

// ---------------------------------------------------------------------------
// Proof 1 — a throwaway room with the human in members
// ---------------------------------------------------------------------------

test("proof 1: a throwaway room exists, validates, and lists the human as a member", () => {
  const { paths, base } = seeded();

  // Created through the path a lane uses: `createRoom` for the room and
  // `createParticipant` for the human, which is what the leader will do in the
  // live store (this test prepares it in a temp store only).
  //
  // `readRoom` is narrowed first, and `onDisk` is annotated, because node's
  // `assert.deepEqual` carries an `asserts actual is T` signature: comparing an
  // unknown against a `Room | null` would otherwise narrow the parsed file to
  // nullable and every later read would need a `!`.
  const room: Room = readRoom(paths, ROOM) as Room;
  assert.ok(room != null, "the room reads back");
  const onDisk: Room = JSON.parse(fs.readFileSync(roomFile(paths), "utf8"));
  assert.deepEqual(onDisk, room, "the file and the reader agree");
  assert.equal(onDisk.name, ROOM);
  assert.ok(isValidRoom(onDisk.name), `${onDisk.name} is a valid room name`);
  assert.deepEqual(onDisk.members, [OPERATOR, AGENT], "the human is a member, first");
  for (const member of onDisk.members) {
    assert.ok(isValidName(member), `${member} survives NAME_RE`);
  }
  assert.equal(typeof onDisk.createdBy, "string");
  assert.ok(!Number.isNaN(Date.parse(onDisk.createdAt)), "createdAt is an instant");

  // The human is a principal, not a registration: a participant record and no
  // pid, cwd or process identity.
  const record = readParticipant(paths, OPERATOR);
  assert.ok(record != null, "operator has a participant record");
  assert.equal(record!.kind, "human");
  assert.equal(record!.client?.tokenSha256, TOKEN_SHA, "the record carries a token lock, not a pid");

  // The CLI can see both, which is what the operator's `rooms who` shows.
  const run = asOperator(base, ["participants", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const names = run.json.participants.map((p: any) => p.name);
  assert.deepEqual(names, [OPERATOR]);
});

// ---------------------------------------------------------------------------
// Proof 2 — uniqueMembers does not eject the human
// ---------------------------------------------------------------------------

test("proof 2: a lane joining the room does not eject the human from members", () => {
  const { paths, base } = seeded();

  // The constraint is real, not hypothetical: `uniqueMembers` really does drop a
  // name that fails NAME_RE. `Operator` (capitalised) is exactly the name a
  // human would pick and exactly the name that would vanish silently.
  assert.equal(isValidName(OPERATOR), true, "the fixed name passes NAME_RE");
  assert.equal(isValidName("Operator"), false, "a capitalised variant does not");
  assert.deepEqual(uniqueMembers(["Operator"]), [], "and it would be deleted, not refused");

  // §7 step 1's hazard: `rooms_join` rewrites `room.json` through
  // `uniqueMembers`, so a member that fails the regex disappears without an
  // error. `rooms join --as <a lane>` is that rewrite, driven by a child process.
  const join = rooms(base, ["join", "--room", ROOM, "--as", NEWCOMER]);
  assert.equal(join.status, 0, join.stderr);
  assert.deepEqual(readRoom(paths, ROOM)!.members, [OPERATOR, AGENT, NEWCOMER]);

  // Call it again, so the member list is round-tripped through a second rewrite.
  assert.deepEqual(addRoomMember(paths, ROOM, NEWCOMER)!.members, [OPERATOR, AGENT, NEWCOMER]);

  // And the member list survives being written back wholesale.
  const room = readRoom(paths, ROOM)!;
  assert.deepEqual(uniqueMembers(room.members), [OPERATOR, AGENT, NEWCOMER]);
  const onDisk = JSON.parse(fs.readFileSync(roomFile(paths), "utf8"));
  assert.ok(onDisk.members.includes(OPERATOR), "operator is still on disk after the rewrites");
});

// ---------------------------------------------------------------------------
// Proof 3 — one DM each way, through different writers
// ---------------------------------------------------------------------------

test("proof 3a: human -> agent goes through bin/rooms as a child process", () => {
  const { paths, base } = seeded();

  const run = asOperator(base, ["dm", "--to", AGENT, "a DM from the human, not from a script"]);
  assert.equal(run.status, 0, run.stderr);
  const id = run.stdout.match(/id ([0-9a-f-]{36})/)?.[1];
  assert.ok(id != null, run.stdout);
  assert.match(run.stdout, /Queued to 1 recipient\(s\): slice-agent/);

  // The envelope is the artifact, not the exit code. It carries the id the CLI
  // printed, the human as `from`, and self-declared provenance marking it as a
  // client write rather than a lane's.
  const pending = inbox(paths, AGENT);
  assert.equal(pending.length, 1);
  const message = pending[0].message;
  assert.equal(message.id, id);
  assert.equal(message.from, OPERATOR);
  assert.deepEqual(message.to, [AGENT]);
  assert.equal(message.via, "cli");
  assert.equal(message.client, "rooms-cli");
  assert.equal(drain(paths, OPERATOR).length, 0, "the sender is never its own recipient");
});

test("proof 3b: agent -> human is deliver(), as a lane does, and carries no cli provenance", () => {
  const { paths } = seeded();

  // What `rooms_dm` does: `deliver` with the lane as `from`. No `via`, no
  // `client` — a lane is not a client, and inventing provenance for it would
  // make the two directions indistinguishable in the artifacts.
  const id = randomUUID();
  const written = deliver(paths, {
    id,
    from: AGENT,
    to: [OPERATOR],
    text: "the leader's answer",
    sentAt: new Date().toISOString(),
  });
  assert.deepEqual(written, [OPERATOR]);

  const pending = inbox(paths, OPERATOR);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message.id, id);
  assert.equal(pending[0].message.from, AGENT);
  assert.equal(pending[0].message.via, undefined, "a lane writes no `via`");
  assert.equal(pending[0].message.client, undefined, "and no `client`");
});

test("proof 3c: the CLI refuses to write as a lane, on every route into a lane's name", () => {
  const { paths, base } = seeded();

  // The §2.3 write-scope line, executable. A lane's name is held by a running
  // process, and two identities sharing one name would merge two inboxes.
  const spoof = rooms(base, ["dm", "--as", AGENT, "--to", OPERATOR, "not mine to send"],
    { PI_ROOMS_CLIENT_TOKEN: TOKEN });
  assert.notEqual(spoof.status, 0, "writing as a live lane is refused");
  assert.match(spoof.stderr, /Refusing to write as slice-agent/);
  assert.match(spoof.stderr, /live pi session/);
  assert.equal(drain(paths, OPERATOR).length, 0, "a refused write writes nothing");

  // A name with no participant record is refused for the other reason the brief
  // names: there is nobody to act for.
  const unregistered = rooms(base, ["dm", "--as", NEWCOMER, "--to", OPERATOR, "nobody"], {});
  assert.notEqual(unregistered.status, 0);
  assert.match(unregistered.stderr, /has no participant record/);

  // And the read direction: a lane's inbox is not a client's to drain, which is
  // the same boundary reached through the one verb that looks read-only.
  const drainLane = rooms(base, ["read", "--as", AGENT], { PI_ROOMS_CLIENT_TOKEN: TOKEN });
  assert.notEqual(drainLane.status, 0);
  assert.match(drainLane.stderr, /has no participant record/);
});

// ---------------------------------------------------------------------------
// Proof 4 — the receipt ladder, which differs per direction
// ---------------------------------------------------------------------------

test("proof 4a: the human's mailbox walks queued -> delivered -> readAt, and only ack writes readAt", () => {
  const { paths, base } = seeded();

  const id = randomUUID();
  deliver(paths, {
    id,
    from: AGENT,
    to: [OPERATOR],
    text: "a reply the human must actually see",
    sentAt: new Date().toISOString(),
  });

  // At deliver: queued only. `deliveredAt` means "a client took these bytes" and
  // nothing has taken them yet.
  let receipt = readReceipts(paths, id)!.receipts[OPERATOR];
  assert.ok(receipt.queuedAt, "queuedAt is written by deliver");
  assert.equal(receipt.deliveredAt, undefined, "queued is not delivered");
  assert.equal(receipt.readAt, undefined);

  // `rooms read` drains the inbox: this is the human's client taking the mail.
  const read = asOperator(base, ["read", "--json"]);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(read.json.delivered, [id], "the client reports the id it took");

  receipt = readReceipts(paths, id)!.receipts[OPERATOR];
  assert.ok(receipt.deliveredAt, "the human's client stamped deliveredAt by taking it");
  assert.equal(receipt.readAt, undefined, "a plain read must never write readAt");

  // Only `ack` says a screen showed the bytes, and it says exactly that.
  const ack = asOperator(base, ["ack", "--id", id, "--json"]);
  assert.equal(ack.status, 0, ack.stderr);
  assert.equal(ack.json.receipt.recipient, undefined);
  assert.equal(ack.json.recipient, OPERATOR);

  receipt = readReceipts(paths, id)!.receipts[OPERATOR];
  assert.ok(receipt.readAt, "ack stamps readAt");
  // The ladder is ordered, which is what makes it evidence rather than three
  // independent stamps that could have been written in any order.
  assert.ok(
    Date.parse(receipt.queuedAt) <= Date.parse(receipt.deliveredAt!),
    "queuedAt <= deliveredAt",
  );
  assert.ok(
    Date.parse(receipt.deliveredAt!) <= Date.parse(receipt.readAt!),
    "deliveredAt <= readAt",
  );
});

test("proof 4b: the agent's receipt stays at queued until a session is handed it, and never gets readAt", () => {
  const { paths, base } = seeded();

  const run = asOperator(base, ["dm", "--to", AGENT, "queued is not delivered"]);
  assert.equal(run.status, 0, run.stderr);
  const id = run.stdout.match(/id ([0-9a-f-]{36})/)?.[1];
  assert.ok(id != null);

  // No pi session ever drained this. Asserting a `deliveredAt` here would be
  // asserting something false, so this asserts its absence.
  let receipt = readReceipts(paths, id)!.receipts[AGENT];
  assert.ok(receipt.queuedAt, "the envelope is in the lane's inbox");
  assert.equal(receipt.deliveredAt, undefined, "no session has been handed it");
  assert.equal(receipt.readAt, undefined);

  // Now do exactly what a lane's flush does — hand it over, then `archive` — and
  // watch `deliveredAt` appear. `readAt` still must not: only a renderer writes
  // that, and a lane has no renderer for the human's mailbox.
  for (const entry of drain(paths, AGENT)) {
    archive(paths, AGENT, entry.file, entry.message);
  }
  receipt = readReceipts(paths, id)!.receipts[AGENT];
  assert.ok(receipt.deliveredAt, "archive is the delivery");
  assert.equal(receipt.readAt, undefined, "the delivery loop never writes readAt");

  // A repeated deliver-time stamp cannot move the evidence backwards either.
  markDelivered(paths, id, AGENT);
  assert.equal(readReceipts(paths, id)!.receipts[AGENT].deliveredAt, receipt.deliveredAt);
});

test("proof 4c: ack refuses an id that is not addressed to the caller", () => {
  const { paths, base } = seeded();

  // A message to the lane. The human must not be able to stamp it.
  const id = randomUUID();
  deliver(paths, {
    id,
    from: AGENT,
    to: [OPERATOR],
    text: "sent to the human",
    sentAt: new Date().toISOString(),
  });
  const agentOnly = randomUUID();
  deliver(paths, {
    id: agentOnly,
    from: OPERATOR,
    to: [AGENT],
    text: "sent to the lane",
    sentAt: new Date().toISOString(),
  });

  const refusal = asOperator(base, ["ack", "--id", agentOnly]);
  assert.equal(refusal.status, 2, "a refusal is a usage error, not a crash");
  assert.match(refusal.stderr, /No message .* in operator's inbox/);
  assert.equal(
    readReceipts(paths, agentOnly)!.receipts[OPERATOR],
    undefined,
    "a refused ack writes no receipt for the caller",
  );
  assert.equal(
    readReceipts(paths, agentOnly)!.receipts[AGENT].readAt,
    undefined,
    "and invents no readAt for the real recipient",
  );

  // A nonsense id is refused the same way, so the check is the inbox and not the
  // shape of the string.
  const nonsense = asOperator(base, ["ack", "--id", "00000000-0000-0000-0000-000000000000"]);
  assert.equal(nonsense.status, 2);
});

// ---------------------------------------------------------------------------
// Proof 5 — the post joins to its envelope and its receipt
// ---------------------------------------------------------------------------

test("proof 5: the log line joins to the envelope and the receipt, in both directions", () => {
  const { paths, base } = seeded();

  const post = asOperator(base, ["post", "--room", ROOM, "first line from a human"]);
  assert.equal(post.status, 0, post.stderr);
  const id = post.stdout.match(/id ([0-9a-f-]{36})/)?.[1];
  assert.ok(id != null, post.stdout);

  // 1. The log line: from the human, via the CLI, carrying an id.
  const lines = logLines(paths);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, id);
  assert.equal(lines[0].from, OPERATOR);
  assert.equal(lines[0].via, "cli");
  assert.equal(lines[0].client, "rooms-cli");

  // 2. The envelope in the member's inbox, with the same id.
  const pending = inbox(paths, AGENT);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message.id, lines[0].id, "the post id is the envelope id");
  assert.equal(pending[0].message.roomSeq, 1);
  assert.equal(pending[0].message.room, ROOM);

  // 3. The receipt, named by that same id, with the recipient's stamp.
  const receipt = readReceipts(paths, id);
  assert.ok(receipt != null, "the id resolves to receipts/<id>.json");
  assert.equal(receipt!.id, id);
  assert.ok(receipt!.receipts[AGENT].queuedAt);
  assert.ok(fs.existsSync(path.join(paths.receipts, `${id}.json`)));

  // 4. The lane's answer in the same log, produced the way `rooms_post` does it,
  //    and its own receipt walking the whole ladder for the human.
  const replyId = randomUUID();
  const seq = readPosts(paths, ROOM, 0, Number.MAX_SAFE_INTEGER).length + 1;
  fs.appendFileSync(
    path.join(paths.rooms, ROOM, "log.jsonl"),
    `${JSON.stringify({
      id: replyId,
      from: AGENT,
      text: "the leader's answer",
      sentAt: new Date().toISOString(),
      recipients: [OPERATOR],
    })}\n`,
  );
  deliver(paths, {
    id: replyId,
    from: AGENT,
    to: [OPERATOR],
    text: "the leader's answer",
    sentAt: new Date().toISOString(),
    room: ROOM,
    roomSeq: seq,
    replyTo: id,
  });

  const answered = logLines(paths);
  assert.equal(answered.length, 2);
  assert.equal(answered[1].from, AGENT);
  assert.equal(answered[1].id, replyId);
  assert.equal(answered[1].via, undefined, "a lane's post carries no cli provenance");

  assert.equal(asOperator(base, ["read", "--json"]).status, 0);
  assert.equal(asOperator(base, ["ack", "--id", replyId]).status, 0);
  const replyReceipt = readReceipts(paths, replyId)!.receipts[OPERATOR];
  assert.ok(replyReceipt.queuedAt && replyReceipt.deliveredAt && replyReceipt.readAt,
    "the human's receipt for the answer has all three stamps");
});

// ---------------------------------------------------------------------------
// Proof 6 — the CLI is the only writer, and the store's writes are all locked
// ---------------------------------------------------------------------------

/**
 * The source of one top-level function, by brace matching from its signature.
 *
 * The body brace is the first `{` at paren depth zero, not the first `{` after
 * the name: an `editPins`-shaped signature carries an object *type* in its
 * parameter list, and matching that would return a fragment of the signature and
 * silently search the wrong text.
 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?function ${name}\\b`));
  assert.ok(start >= 0, `${name} is in the source`);
  let parens = 0;
  let bodyStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") parens += 1;
    else if (ch === ")") parens -= 1;
    else if (ch === "{" && parens === 0) {
      bodyStart = i;
      break;
    }
  }
  assert.ok(bodyStart >= 0, `${name} has a body`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name}'s body is unterminated`);
}

test("proof 6a: the CLI holds no filesystem write of its own, and delegates every write", () => {
  const cli = fs.readFileSync(BIN, "utf8");

  // The argument, structurally: the client cannot bypass `withFileLock` because
  // it never touches the filesystem. It cannot write an unlocked receipt because
  // it does not open a file at all — it calls the store, where the lock lives.
  for (const forbidden of [
    'from "node:fs"',
    'from "fs"',
    "writeFileSync",
    "appendFileSync",
    "renameSync",
    "copyFileSync",
    "unlinkSync",
    "mkdirSync",
  ]) {
    assert.equal(cli.includes(forbidden), false, `bin/rooms never calls ${forbidden}`);
  }

  // And it really goes through the store's locked entry points rather than
  // re-implementing them. `saveRoom` is the unlocked-write signature to be
  // absent: `addRoomMember` is the locked read-modify-write.
  for (const required of [
    "store_.deliver(",
    "store_.appendPost(",
    "store_.markRead(",
    "store_.addRoomMember(",
    "store_.drain(",
    "store_.archive(",
    "store_.readReceipts(",
  ]) {
    assert.ok(cli.includes(required), `bin/rooms calls ${required}`);
  }
  assert.equal(cli.includes("store_.saveRoom("), false, "a room rewrite goes through addRoomMember");
  assert.equal(cli.includes("store_.markDelivered("), false,
    "the CLI's only route to deliveredAt is archive(), i.e. taking the bytes");

  // `readAt` is written in exactly one place in the CLI: ack.
  assert.equal(cli.split("store_.markRead(").length - 1, 1, "markRead is called once");
});

test("proof 6b: the store's writes to receipts, room.json and names.json all take the lock", () => {
  const store = fs.readFileSync(path.join(HERE, "..", "src", "store.ts"), "utf8");
  const pins = fs.readFileSync(path.join(HERE, "..", "src", "pins.ts"), "utf8");

  // Receipts: every stamp merges inside `recordReceipt`, under the receipt's lock.
  const recordReceipt = functionBody(store, "recordReceipt");
  assert.ok(recordReceipt.includes("withFileLock(file"), "recordReceipt holds the receipt lock");
  assert.ok(recordReceipt.includes("writeJsonAtomic(file, existing)"), "and writes inside it");

  // room.json: both writers — the wholesale save and the read-modify-write that
  // `rooms join` uses — span the read.
  for (const name of ["saveRoom", "addRoomMember"]) {
    const body = functionBody(store, name);
    assert.ok(body.includes("withFileLock("), `${name} holds the room lock`);
    assert.ok(body.includes("writeJsonAtomic(file, room)"), `${name} writes inside it`);
  }

  // names.json: the pin file's only production writer is `editPins`, which locks
  // across the read and the write. `writePinFile` stays raw for tests, so assert
  // its non-test callers are exactly `editPins`.
  assert.ok(functionBody(pins, "editPins").includes("withFileLock(pinPath(paths)"));
  const callers = fs
    .readdirSync(path.join(HERE, "..", "src"))
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => {
      const src = fs.readFileSync(path.join(HERE, "..", "src", f), "utf8");
      const source = f === "pins.ts" ? functionBody(src, "editPins") : src;
      return source.split("writePinFile(").length - 1 > 0 ? [f] : [];
    });
  assert.deepEqual(callers, ["pins.ts"], "writePinFile is called from pins.ts only");
  assert.equal(
    functionBody(pins, "editPins").split("writePinFile(").length - 1,
    1,
    "and only from inside editPins",
  );
});

test("proof 6c: a held lock stops the CLI, on the room and on the receipt", () => {
  const { paths, base } = seeded();

  /** Hold a lock the way a live writer would: this process's pid, no boot stamp. */
  function hold(file: string): string {
    const lockPath = `${file}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    return lockPath;
  }

  // room.json — the CLI's join path must block on the same lock a lane holds.
  const roomLock = hold(roomFile(paths));
  const blockedJoin = rooms(base, ["join", "--room", ROOM, "--as", NEWCOMER]);
  assert.notEqual(blockedJoin.status, 0, "join cannot write behind a held lock");
  assert.match(blockedJoin.stderr, /Could not lock .*room\.json\.lock/);
  assert.deepEqual(readRoom(paths, ROOM)!.members, [OPERATOR, AGENT], "and it wrote nothing");
  fs.unlinkSync(roomLock);
  assert.equal(rooms(base, ["join", "--room", ROOM, "--as", NEWCOMER]).status, 0,
    "with the lock released the same write succeeds");

  // receipts/<id>.json — ack's stamp must block on the receipt lock too. Without
  // this, "the CLI cannot write an unlocked receipt" would be a claim about the
  // source rather than about behaviour.
  const id = randomUUID();
  deliver(paths, {
    id,
    from: AGENT,
    to: [OPERATOR],
    text: "ack must take the receipt lock",
    sentAt: new Date().toISOString(),
  });
  const receiptLock = hold(path.join(paths.receipts, `${id}.json`));
  const blockedAck = asOperator(base, ["ack", "--id", id]);
  assert.notEqual(blockedAck.status, 0, "ack cannot stamp behind a held receipt lock");
  assert.match(blockedAck.stderr, /Could not lock/);
  assert.equal(readReceipts(paths, id)!.receipts[OPERATOR].readAt, undefined, "nothing was stamped");
  fs.unlinkSync(receiptLock);
  assert.equal(asOperator(base, ["ack", "--id", id]).status, 0, "and succeeds once released");
  assert.ok(readReceipts(paths, id)!.receipts[OPERATOR].readAt);
});

// ---------------------------------------------------------------------------
// The operator runbook, checked as written
//
// Two commands in `G3b-operator-runbook.md` do not do what that document says
// they do. Neither is a `C1` defect — the store behaves as designed in both
// cases — so neither is a failing test. They are pinned here so the runbook's
// reader gets the observation rather than a claim, and so a later change to the
// store cannot quietly move the discrepancy somewhere else.
//
// These assert the *current* behaviour. If the leader decides the fix is in the
// code rather than the runbook, these two tests are the ones that must change.
// ---------------------------------------------------------------------------

test("runbook check 3: an inbox filename carries the id's first 8 chars, not the whole id", () => {
  const { paths, base } = seeded();

  // As written, step 2's third check is:
  //   ls <store>/inbox/<member>/ | grep <id-from-line-1>
  // The envelope's *body* carries the full id, but the *file name* is built from
  // `stamp-index-id.slice(0,8)`, so the full 36-character id never appears in a
  // filename and `grep` exits 1 while the message is sitting right there.
  const run = asOperator(base, ["dm", "--to", AGENT, "check three"]);
  assert.equal(run.status, 0, run.stderr);
  const id = run.stdout.match(/id ([0-9a-f-]{36})/)?.[1];
  assert.ok(id != null);

  const files = fs.readdirSync(path.join(paths.inbox, AGENT));
  assert.equal(files.length, 1, "the envelope is in the member's inbox");
  assert.equal(files[0].includes(id), false, "the full id is NOT in the filename");
  assert.ok(files[0].includes(id.slice(0, 8)), "only the id's 8-char prefix is");

  // What actually proves the inbox received it, which is what the runbook means.
  const body = JSON.parse(fs.readFileSync(path.join(paths.inbox, AGENT, files[0]), "utf8"));
  assert.equal(body.id, id, "the envelope body carries the full id");
});

test("runbook step 5: streaming a room does not stamp deliveredAt; the inbox read does", () => {
  const { paths, base } = seeded();

  // The lane answers in the room, the way `rooms_post` does.
  const replyId = randomUUID();
  const seq = readPosts(paths, ROOM, 0, Number.MAX_SAFE_INTEGER).length + 1;
  fs.appendFileSync(
    path.join(paths.rooms, ROOM, "log.jsonl"),
    `${JSON.stringify({ id: replyId, from: AGENT, text: "the leader's answer", sentAt: new Date().toISOString(), recipients: [OPERATOR] })}\n`,
  );
  deliver(paths, {
    id: replyId,
    from: AGENT,
    to: [OPERATOR],
    text: "the leader's answer",
    sentAt: new Date().toISOString(),
    room: ROOM,
    roomSeq: seq,
  });
  assert.equal(readReceipts(paths, replyId)!.receipts[OPERATOR].deliveredAt, undefined);

  // Step 5 says `read --room <slice-room> --follow` and then ack gives all three
  // stamps. It does not: `--follow` reads the room *log*, and the room log is not
  // the human's inbox. The envelope still sits in `inbox/operator/`, so nothing
  // has taken the bytes and `deliveredAt` stays absent — the receipt keeps the
  // `queuedAt → readAt` gap the runbook elsewhere says it wants to avoid.
  const follow = spawnSync(
    process.execPath,
    [BIN, "read", "--room", ROOM, "--follow", "--as", OPERATOR],
    {
      encoding: "utf8",
      env: { ...process.env, PI_ROOMS_DIR: base, PI_ROOMS_CLIENT_TOKEN: TOKEN },
      timeout: 1500,
      killSignal: "SIGTERM",
    },
  );
  // The room is `ROOM`, not the runbook's `slice-room` placeholder: the preamble
  // goes to stderr so stdout stays pure NDJSON.
  assert.match(follow.stderr ?? "", new RegExp(`following ${ROOM}`));
  assert.equal(
    readReceipts(paths, replyId)!.receipts[OPERATOR].deliveredAt,
    undefined,
    "following the room log does not take the inbox copy",
  );

  // What does complete the ladder: draining the human's own inbox, then acking.
  assert.equal(asOperator(base, ["read"]).status, 0);
  assert.ok(
    readReceipts(paths, replyId)!.receipts[OPERATOR].deliveredAt,
    "`rooms read --as operator` is the drain that stamps deliveredAt",
  );
  assert.equal(asOperator(base, ["ack", "--id", replyId]).status, 0);
  const receipt = readReceipts(paths, replyId)!.receipts[OPERATOR];
  assert.ok(receipt.queuedAt && receipt.deliveredAt && receipt.readAt,
    "and then the ladder is complete: queued -> delivered -> readAt");
});
