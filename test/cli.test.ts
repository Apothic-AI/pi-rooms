/**
 * CLI tests — `bin/rooms`, the writer a human uses.
 *
 * Every test drives the real executable in a child process against a temp store.
 * Nothing here touches `~/.pi/agent/rooms`: the store is sealed by `PI_ROOMS_DIR`,
 * which is also the mechanism an operator uses to point the CLI somewhere else.
 *
 * The properties under test are the ones whose failure mode is *silence* — a post
 * that merges into the previous line, a receipt stamped for the wrong name, a name
 * that would be dropped from a room's members without an error. Each of those
 * looks like success from the caller's side, so a test that only asserted an exit
 * code of zero would prove nothing. Every assertion below reads the artifact.
 *
 * The compatibility test near the end is the load-bearing one for the live fleet:
 * a store the CLI has written to must still parse with the unmodified `src/store.ts`
 * functions every running lane already loads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendPost,
  archive,
  bootId,
  createParticipant,
  createRoom,
  deliver,
  drain,
  enforceMessageCap,
  isRegistrationLive,
  listAgents,
  markDelivered,
  MAX_MESSAGE_CHARS,
  procIdentity,
  readParticipant,
  readPosts,
  readPresence,
  readReceipts,
  readRegistration,
  readRoom,
  register,
  resolvePaths,
  roomSeq,
  sanitize,
  TRUNCATION_MARKER_RE,
  type Paths,
} from "../src/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "rooms");

const OPERATOR = "operator";
const TOKEN = "test-client-token";
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

/** Run the CLI. `env` is merged over the current environment, never replacing it. */
function rooms(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_ROOMS_CLIENT_TOKEN: "", ...env },
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

function tempPaths(): Paths {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-cli-"));
  return resolvePaths(base);
}

/**
 * A store with `operator` (a human with a client token) in a room with a lane.
 *
 * The lane is registered to *this* test process, so `isRegistrationLive` says it
 * is live without needing to spawn anything: the "refuse to write as a lane name"
 * rule is about a name a running process holds, and this process is running.
 */
function seeded(): { paths: Paths; base: string; room: string; lane: string } {
  const paths = tempPaths();
  createParticipant(paths, {
    name: OPERATOR,
    kind: "human",
    displayName: "Alex",
    createdBy: "test",
    client: { id: "cli", label: "rooms-cli", tokenSha256: TOKEN_SHA },
  });
  const room = "slice-one";
  const lane = "leader-lane";
  createRoom(paths, {
    name: room,
    members: [OPERATOR, lane],
    createdBy: lane,
    createdAt: new Date().toISOString(),
  });
  const stamp = new Date().toISOString();
  register(paths, {
    name: lane,
    pid: process.pid,
    cwd: "/work/leader",
    startedAt: stamp,
    updatedAt: stamp,
    procId: procIdentity(process.pid) ?? undefined,
    bootId: bootId() ?? undefined,
  });
  return { paths, base: paths.base, room, lane };
}

function env(base: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PI_ROOMS_DIR: base, ...extra };
}

/**
 * The CLI run as the human, with the right token.
 *
 * `--as operator` is injected unless the call already names an identity, because
 * every write verb requires one and no verb falls back to a guess. A test that
 * wants to exercise a *different* name passes its own `--as` and this leaves it
 * alone.
 */
function operator(base: string, args: string[]): Run {
  const withIdentity = args.includes("--as") ? args : [args[0], "--as", OPERATOR, ...args.slice(1)];
  return rooms(withIdentity, env(base, { PI_ROOMS_CLIENT_TOKEN: TOKEN }));
}

function logLines(paths: Paths, room: string): string[] {
  const file = path.join(paths.rooms, room, "log.jsonl");
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// C1 — post: the four rules that keep a second writer safe
// ---------------------------------------------------------------------------

test("post writes one terminated line, fans out an envelope, and reads its seq back", () => {
  const { paths, base, room, lane } = seeded();

  const run = operator(base, ["post", "--room", room, "hello", "from", "the", "operator"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /as #1/, "the reported number is the one a read assigns");

  // Rule 1: exactly one line, and it ends in a newline. A client whose last byte
  // is not `\n` merges the next agent's post into an unparseable line and both
  // vanish from `readPosts` while still consuming a seq.
  const raw = fs.readFileSync(path.join(paths.rooms, room, "log.jsonl"), "utf8");
  assert.ok(raw.endsWith("\n"), "the log's last byte is a newline");
  assert.equal(raw.split("\n").filter((l) => l.trim().length > 0).length, 1);

  // The envelope reached the other member, and the sender's own mailbox did not
  // receive its own post.
  const pending = drain(paths, lane);
  assert.equal(pending.length, 1);
  const message = pending[0].message;
  assert.equal(message.from, OPERATOR);
  assert.equal(message.room, room);
  assert.equal(message.roomSeq, 1, "the envelope carries the read-back number, not a prediction");
  assert.equal(drain(paths, OPERATOR).length, 0, "a sender is never its own recipient");

  // One id for the log line and the envelope, so a post joins to its receipts.
  const posts = readPosts(paths, room, 0, 1000);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, message.id, "post id and envelope id are the same value");
  assert.ok(readReceipts(paths, message.id) != null, "the receipt names an id the history contains");
});

test("post stamps self-declared provenance on the line and the envelope", () => {
  const { paths, base, room, lane } = seeded();
  assert.equal(operator(base, ["post", "--room", room, "provenance"]).status, 0);

  const [line] = logLines(paths, room);
  const post = JSON.parse(line);
  assert.equal(post.via, "cli");
  assert.equal(post.client, "rooms-cli");

  const message = drain(paths, lane)[0].message;
  assert.equal(message.via, "cli", "the envelope carries provenance too");
  assert.equal(message.client, "rooms-cli");

  // The label is configurable without a config file, which is the whole point of
  // keeping it an env var in slice 1.
  const other = rooms(["post", "--room", room, "labelled", "--as", OPERATOR], env(base, {
    PI_ROOMS_CLIENT_TOKEN: TOKEN,
    PI_ROOMS_CLIENT_LABEL: "some-other-client",
  }));
  assert.equal(other.status, 0, other.stderr);
  const last = JSON.parse(logLines(paths, room).at(-1)!);
  assert.equal(last.client, "some-other-client");
});

test("post refuses a long draft's tail loudly, and never silently", () => {
  const { paths, base, room } = seeded();
  const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
  const run = operator(base, ["post", "--room", room, long, "--json"]);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.truncated, true, "--json tells a machine reader the tail was cut");
  assert.match(run.stderr, /truncated/i, "the human is told before the send counts as successful");

  const post = JSON.parse(logLines(paths, room)[0]);
  assert.match(post.text, TRUNCATION_MARKER_RE, "the stored text ends with the existing marker");
  assert.ok(post.text.length > MAX_MESSAGE_CHARS, "the marker is added, not silently sliced off");
  assert.match(post.text, /truncated 500 chars/);
});

test("post refuses a room the writer is not a member of", () => {
  const { paths, base } = seeded();
  createRoom(paths, {
    name: "not-mine",
    members: ["leader-lane"],
    createdBy: "leader-lane",
    createdAt: new Date().toISOString(),
  });
  const run = operator(base, ["post", "--room", "not-mine", "hello?"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not a member/i);
  assert.match(run.stderr, /rooms join/, "the error names the verb that fixes it");
  assert.equal(roomSeq(paths, "not-mine"), 0, "nothing was written");
});

test("appendPost enforces the cap even when a caller forgets to", () => {
  // The cap used to live only in the tool handlers, which made it a convention of
  // one caller. A second writer that appended directly bypassed it entirely.
  const paths = tempPaths();
  createRoom(paths, { name: "r", members: ["a"], createdBy: "a", createdAt: new Date().toISOString() });
  appendPost(paths, "r", {
    from: "a",
    text: "y".repeat(MAX_MESSAGE_CHARS + 25),
    sentAt: new Date().toISOString(),
    recipients: [],
  });
  const [post] = readPosts(paths, "r", 0, 10);
  assert.match(post.text, TRUNCATION_MARKER_RE, "the store itself adds the marker");
  assert.match(post.text, /truncated 25 chars/);
});

test("the cap is idempotent, so a writer and the store cannot cut twice", () => {
  const once = enforceMessageCap("z".repeat(MAX_MESSAGE_CHARS + 40));
  assert.match(once, TRUNCATION_MARKER_RE);
  assert.equal(enforceMessageCap(once), once, "a second pass does not slice into the marker");
  assert.equal(sanitize("a\u0000b"), "ab", "control characters are still stripped");
  // A message that merely *ends* in marker-shaped words is not a capped message.
  const liar = `${"q".repeat(MAX_MESSAGE_CHARS + 10)}\n… [truncated 1 chars]`;
  assert.match(enforceMessageCap(liar), /truncated \d+ chars/, "it is capped on its real length");
});

// ---------------------------------------------------------------------------
// C2 — dm
// ---------------------------------------------------------------------------

test("dm records its recipient set, which is what reply-all resolves", () => {
  const { paths, base, lane } = seeded();
  createParticipant(paths, { name: "second-lane", kind: "agent", createdBy: "test" });
  const run = operator(base, ["dm", "--to", `${lane},second-lane`, "direct", "note", "--json"]);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.json.delivered.sort(), [lane, "second-lane"].sort());
  assert.equal(run.json.via, "cli");

  const toLane = drain(paths, lane)[0].message;
  assert.deepEqual(toLane.to, [lane, "second-lane"], "the whole recipient set is on the message");
  assert.equal(toLane.room, undefined, "a dm is not a room post");
  assert.ok(readReceipts(paths, toLane.id)?.receipts?.[lane]?.queuedAt != null);
});

test("dm --reply-to records transport metadata and nothing more", () => {
  const { paths, base, lane } = seeded();
  const original = "11111111-1111-4111-8111-111111111111";
  const run = operator(base, ["dm", "--to", lane, "answering", "--reply-to", original, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.replyTo, original);
  assert.equal(drain(paths, lane)[0].message.replyTo, original);
});

test("dm refuses a token mismatch and writes nothing", () => {
  const { paths, base, lane } = seeded();
  const run = rooms(
    ["dm", "--to", lane, "nope", "--as", OPERATOR, "--token", "wrong"],
    env(base),
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /participants\/operator\.json/, "the message names the participant file");
  assert.match(run.stderr, /not a credential/, "and does not describe the token as authentication");
  assert.equal(drain(paths, lane).length, 0);
});

// ---------------------------------------------------------------------------
// C3 — read: room history, and the inbox drain that stamps deliveredAt
// ---------------------------------------------------------------------------

test("read returns every post after --since, with no limit", () => {
  // A `limit` would return the newest N of a backlog and never the start, and a
  // mid-catch-up truncation skips the middle. 60 posts is beyond the default 50.
  const { paths, base, room } = seeded();
  for (let i = 0; i < 60; i += 1) {
    appendPost(paths, room, {
      id: randomUUID(),
      from: OPERATOR,
      text: `post ${i}`,
      sentAt: new Date().toISOString(),
      recipients: ["leader-lane"],
    });
  }

  const all = operator(base, ["read", "--room", room, "--json"]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.json.posts.length, 60, "the whole history, not the newest 50");
  assert.equal(all.json.posts[0].seq, 1, "the start is present");

  const tail = operator(base, ["read", "--room", room, "--since", "57", "--json"]);
  assert.equal(tail.json.posts.length, 3);
  assert.equal(tail.json.posts[0].seq, 58, "--since is exclusive");
  assert.equal(tail.json.total, 60);
});

test("read on the inbox stamps deliveredAt and moves the envelope", () => {
  const { paths, base, room } = seeded();
  const id = randomUUID();
  const sentAt = new Date().toISOString();
  deliver(paths, {
    id,
    from: "leader-lane",
    to: [OPERATOR],
    text: "mail for the human",
    sentAt,
    room,
    roomSeq: 1,
  });

  const run = operator(base, ["read", "--as", OPERATOR, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.kind, "inbox");
  assert.equal(run.json.messages.length, 1);
  assert.equal(run.json.messages[0].id, id);

  // deliveredAt means "this client now has the bytes". It is deliberately not
  // readAt: collapsing the two would make readAt mean "opened a stream".
  const receipt = readReceipts(paths, id)!.receipts[OPERATOR];
  assert.ok(receipt.deliveredAt != null, "read stamps deliveredAt");
  assert.equal(receipt.readAt, undefined, "read must not invent readAt");

  assert.equal(drain(paths, OPERATOR).length, 0, "the envelope left the queue");
  assert.ok(
    fs.existsSync(path.join(paths.inbox, OPERATOR, "read", `${id}.json`)),
    "and the archived copy is the tiebreaker a receipt can lose",
  );
  const archived = JSON.parse(fs.readFileSync(path.join(paths.inbox, OPERATOR, "read", `${id}.json`), "utf8"));
  assert.ok(archived.deliveredAt != null);
  assert.equal(archived.from, "leader-lane", "the archived copy still parses with the old fields");
});

test("read needs a room or a name, and never reaches another name's inbox", () => {
  const { base } = seeded();
  const bare = rooms(["read"], env(base));
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--room/);

  // There is no flag that names someone else's mailbox. `--as` is the identity the
  // read acts for, and it is resolved against the participant record and token.
  const other = rooms(["read", "--as", "leader-lane"], env(base, { PI_ROOMS_CLIENT_TOKEN: TOKEN }));
  assert.equal(other.status, 1);
  assert.match(other.stderr, /no participant record/i);
});

// ---------------------------------------------------------------------------
// C4 — ack: readAt, for one recipient, and only for its own mail
// ---------------------------------------------------------------------------

test("ack stamps readAt for --as on a message addressed to it", () => {
  const { paths, base } = seeded();
  const id = randomUUID();
  deliver(paths, {
    id,
    from: "leader-lane",
    to: [OPERATOR],
    text: "did you see this?",
    sentAt: new Date().toISOString(),
  });

  const run = operator(base, ["ack", "--as", OPERATOR, "--id", id, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.json.receipt.readAt != null);
  assert.equal(run.json.receipt.readAt, readReceipts(paths, id)!.receipts[OPERATOR].readAt);

  // First read wins: acking twice is not new information and must not move the stamp.
  const first = run.json.receipt.readAt;
  const again = operator(base, ["ack", "--as", OPERATOR, "--id", id, "--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.receipt.readAt, first, "a repeat ack does not reorder delivery evidence");
});

test("ack refuses a message that is not in the caller's own inbox", () => {
  const { paths, base, lane } = seeded();
  const id = randomUUID();
  // Addressed to the lane, not to the human.
  deliver(paths, {
    id,
    from: "someone",
    to: [lane],
    text: "not yours",
    sentAt: new Date().toISOString(),
  });

  const run = operator(base, ["ack", "--as", OPERATOR, "--id", id]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /cannot reach another name's inbox/i);

  // And the recipient's own receipt is untouched: no readAt was written for it.
  const receipt = readReceipts(paths, id)!.receipts[lane];
  assert.equal(receipt.readAt, undefined);
  assert.ok(receipt.queuedAt != null);
});

// ---------------------------------------------------------------------------
// C5 — join, participants, presence, list, who
// ---------------------------------------------------------------------------

test("join adds --as through the locked room rewrite", () => {
  const { paths, base, lane } = seeded();
  createRoom(paths, {
    name: "second-room",
    members: [lane],
    createdBy: lane,
    createdAt: new Date().toISOString(),
  });

  const run = operator(base, ["join", "--room", "second-room", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.json.members, [lane, OPERATOR]);

  const room = readRoom(paths, "second-room")!;
  assert.ok(room.members.includes(OPERATOR), "membership persists in room.json");
  assert.equal(room.createdBy, lane, "joining does not rewrite the room's provenance");
  assert.equal(fs.existsSync(`${path.join(paths.rooms, "second-room", "room.json")}.lock`), false, "the lock is released");

  const missing = operator(base, ["join", "--room", "nope"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist/i);
});

test("join accepts a name with no participant record, and post does not", () => {
  // A human may exist before its record does — §7's walkthrough has the leader
  // create the room and the operator join it. Every other write acts *as* a
  // principal, so every other write needs one to act for.
  const { paths, base, lane } = seeded();
  createRoom(paths, {
    name: "early-room",
    members: [lane],
    createdBy: lane,
    createdAt: new Date().toISOString(),
  });

  const join = rooms(["join", "--room", "early-room", "--as", "early-human"], env(base));
  assert.equal(join.status, 0, join.stderr);
  assert.ok(readRoom(paths, "early-room")!.members.includes("early-human"));

  const post = rooms(["post", "--room", "early-room", "--as", "early-human", "hello?"], env(base));
  assert.equal(post.status, 1);
  assert.match(post.stderr, /no participant record/i);
  assert.match(post.stderr, /rooms join/, "the message explains why join was allowed and this is not");
  assert.equal(roomSeq(paths, "early-room"), 0, "the refused post wrote nothing");
});

test("every invocation with a participant record writes an online lease", () => {
  const { paths, base, room } = seeded();
  const before = readPresence(paths, OPERATOR);
  assert.equal(before.state, "unknown", "nothing declared yet");

  const start = Date.now();
  assert.equal(operator(base, ["post", "--room", room, "lease me"]).status, 0);

  const lease = JSON.parse(fs.readFileSync(path.join(paths.presence, `${OPERATOR}.json`), "utf8"));
  assert.equal(lease.state, "online", "slice 1's presence is static: online on each invocation");
  assert.equal(lease.client, "rooms-cli");
  assert.equal(lease.note, null);
  const leaseMs = Date.parse(lease.leaseUntil) - Date.parse(lease.lastSeenAt);
  assert.equal(leaseMs, 60_000, "leaseUntil is lastSeenAt + 60s");
  assert.ok(Date.now() - start < 30_000, "and it was written by this invocation, not an earlier one");

  const view = readPresence(paths, OPERATOR);
  assert.equal(view.state, "online", "a live lease derives to online");
  assert.ok(view.ageMs != null && view.ageMs < 30_000);
});

test("there is no verb that sets another name's presence, and no away flag", () => {
  const { base } = seeded();
  // `presence set` is not a verb: the help lists `presence` alone.
  const set = operator(base, ["presence", "set", "--as", OPERATOR]);
  assert.equal(set.status, 0, "unknown trailing words are not an error, but they are not a verb either");
  assert.doesNotMatch(set.stdout, /set/i, "nothing describes a presence-set action");

  const away = operator(base, ["presence", "--as", OPERATOR, "--away"]);
  // `--away` is not a flag this verb knows, so it is inert rather than implemented.
  assert.equal(away.status, 0);
});

test("participants and who show the human section, and presence never says live", () => {
  const { base } = seeded();
  const participants = operator(base, ["participants", "--json"]);
  assert.equal(participants.status, 0, participants.stderr);
  assert.equal(participants.json.participants.length, 1);
  assert.equal(participants.json.participants[0].name, OPERATOR);
  assert.equal(participants.json.participants[0].kind, "human");
  assert.equal(
    participants.json.participants[0].client.tokenSha256,
    TOKEN_SHA,
    "the token hash is the only token material a reader sees",
  );

  const who = operator(base, ["who", "--json"]);
  assert.equal(who.status, 0, who.stderr);
  assert.equal(who.json.agents.length, 1, "the live lane is listed");
  assert.equal(who.json.humans.length, 1);
  assert.equal(who.json.humans[0].participant.name, OPERATOR);
  assert.match(who.json.note, /lease/i);
  assert.match(who.json.note, /not liveness/i);
  assert.match(who.json.note, /self-declared/i);

  const text = operator(base, ["who"]);
  assert.match(text.stdout, /human participant/i, "humans get their own section");
  assert.doesNotMatch(text.stdout, /\blive\b/i, "a lease is never rendered as liveness");
  assert.match(text.stdout, /not authenticated/i, "provenance is described as a signal");
});

test("list reports post counts and members", () => {
  const { base, room } = seeded();
  assert.equal(operator(base, ["post", "--room", room, "one"]).status, 0);
  assert.equal(operator(base, ["post", "--room", room, "two"]).status, 0);

  const run = operator(base, ["list", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const entry = run.json.rooms.find((r: any) => r.name === room);
  assert.equal(entry.posts, 2);
  assert.deepEqual(entry.members, [OPERATOR, "leader-lane"]);
});

// ---------------------------------------------------------------------------
// C6 — identity: the rules that stop two identities sharing one name
// ---------------------------------------------------------------------------

test("a write without --as is refused rather than attributed by guessing", () => {
  const { paths, base, room } = seeded();
  const run = rooms(["post", "--room", room, "who am i"], env(base));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /needs --as/i);
  assert.match(run.stderr, /guessing/i, "the message says why there is no fallback");
  assert.equal(roomSeq(paths, room), 0);
});

test("a write as a live lane's name is refused", () => {
  const { paths, base, room } = seeded();
  const registration = readRegistration(paths, "leader-lane")!;
  assert.equal(isRegistrationLive(registration), true, "the seeded lane really is live");

  const run = operator(base, ["post", "--room", room, "--as", "leader-lane", "in their voice"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /live pi session/i);
  assert.match(run.stderr, new RegExp(String(registration.pid)), "the error names the pid holding it");
  assert.equal(roomSeq(paths, room), 0, "no post was written in that lane's name");
});

test("a NAME_RE-invalid name is refused, because the store would drop it silently", () => {
  const { paths, base, room } = seeded();
  for (const bad of ["Operator", "operator:human", "-leading", "with space", "a".repeat(49)]) {
    const run = operator(base, ["post", "--room", room, "--as", bad, "x"]);
    assert.equal(run.status, 2, `${JSON.stringify(bad)} must be refused`);
    assert.match(run.stderr, /not a valid rooms name/i);
  }
  assert.equal(roomSeq(paths, room), 0);
});

test("a participant record with no token hash fails closed", () => {
  // A record that cannot be locked is a name any client may write under, so it is
  // refused rather than treated as an unprotected name.
  const paths = tempPaths();
  createParticipant(paths, {
    name: "unlocked",
    kind: "human",
    createdBy: "test",
    client: { id: "cli", label: "rooms-cli" },
  });
  createRoom(paths, {
    name: "r",
    members: ["unlocked"],
    createdBy: "test",
    createdAt: new Date().toISOString(),
  });
  const run = rooms(["post", "--room", "r", "--as", "unlocked", "x"], env(paths.base));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /declares no client token/i);
  assert.equal(roomSeq(paths, "r"), 0);
});

test("the token can come from PI_ROOMS_CLIENT_TOKEN or from --token", () => {
  const { base, room } = seeded();
  const fromEnv = rooms(["post", "--room", room, "env token", "--as", OPERATOR], env(base, { PI_ROOMS_CLIENT_TOKEN: TOKEN }));
  assert.equal(fromEnv.status, 0, fromEnv.stderr);

  const fromFlag = rooms(
    ["post", "--room", room, "flag token", "--as", OPERATOR, "--token", TOKEN],
    env(base, { PI_ROOMS_CLIENT_TOKEN: "" }),
  );
  assert.equal(fromFlag.status, 0, fromFlag.stderr);

  const missing = rooms(["post", "--room", room, "no token", "--as", OPERATOR], env(base, { PI_ROOMS_CLIENT_TOKEN: "" }));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--token/);
  assert.match(missing.stderr, /PI_ROOMS_CLIENT_TOKEN/);
});

// ---------------------------------------------------------------------------
// C7 — compatibility with the ~50 lanes already running d4d0bfa
// ---------------------------------------------------------------------------

test("a store the CLI wrote to still parses with the unmodified store functions", () => {
  // This is the load-bearing test for the live fleet: an old lane must keep
  // working against a store this CLI has written to. Every read below is an
  // ordinary `src/store.ts` call with no CLI involvement.
  const { paths, base, room, lane } = seeded();

  assert.equal(operator(base, ["post", "--room", room, "written by the cli"]).status, 0);
  assert.equal(operator(base, ["dm", "--to", lane, "and a dm"]).status, 0);

  const [post] = readPosts(paths, room, 0, 10);
  // The old fields, unchanged.
  assert.equal(post.from, OPERATOR);
  assert.equal(post.text, "written by the cli");
  assert.equal(typeof post.sentAt, "string");
  assert.deepEqual(post.recipients, [lane]);
  assert.equal(typeof post.seq, "number");
  // And the additive ones, which an old reader spreads without knowing them.
  assert.equal(typeof post.id, "string");
  assert.equal(post.via, "cli");

  // `uniqueMembers` is the path that silently deletes a non-NAME_RE member from
  // room.json. The CLI wrote a NAME_RE name, so a lane joining must not eject it.
  const roomRecord = readRoom(paths, room)!;
  assert.deepEqual(roomRecord.members, [OPERATOR, lane], "the CLI's name survives a member rewrite");

  // The envelope parses, and carries a string `id` — an envelope without one
  // wedges a lane's inbox forever, retried every tick.
  const inbox = drain(paths, lane);
  assert.equal(inbox.length, 2, "one room post and one dm");
  for (const { message } of inbox) {
    assert.equal(typeof message.id, "string");
    assert.equal(message.from, OPERATOR);
    assert.deepEqual(message.to, [lane]);
  }

  // The receipt has the one field an old lane reads, and the readAt the CLI adds
  // does not disturb it.
  const postId = post.id!;
  const receipt = readReceipts(paths, postId)!;
  assert.equal(receipt.id, postId);
  assert.ok(receipt.receipts[lane].queuedAt != null);
});

test("an old lane's markDelivered does not erase the readAt the CLI stamped", () => {
  // §3.3's lost-update: `recordReceipt` used to reconstruct the per-recipient
  // object, so any writer that did not know about a field erased it. The CLI is a
  // *second* writer next to lanes running the older code path in every other
  // respect, so this is the interaction that has to hold.
  const { paths, base } = seeded();
  const id = randomUUID();
  deliver(paths, {
    id,
    from: "leader-lane",
    to: [OPERATOR],
    text: "seen and stamped",
    sentAt: new Date().toISOString(),
  });

  assert.equal(operator(base, ["ack", "--as", OPERATOR, "--id", id]).status, 0);
  const stamped = readReceipts(paths, id)!.receipts[OPERATOR].readAt;
  assert.ok(stamped != null);

  // An old lane's delivery loop writing its own stamps for its own recipient.
  markDelivered(paths, id, "leader-lane");
  markDelivered(paths, id, OPERATOR);

  const after = readReceipts(paths, id)!.receipts[OPERATOR];
  assert.equal(after.readAt, stamped, "readAt survives an unrelated writer");
  assert.ok(after.queuedAt != null, "and so does queuedAt");
  assert.ok(after.deliveredAt != null, "while the new stamp is added");
});

// ---------------------------------------------------------------------------
// C8 — --follow: an NDJSON stream, and a gap said out loud
// ---------------------------------------------------------------------------

/**
 * Run `read --follow` and collect its stdout lines while a callback runs.
 *
 * The stream is polled rather than slept on, so the test costs the time the events
 * take and not a fixed wait.
 */
async function follow(
  base: string,
  args: string[],
  during: (write: (line: string) => void) => Promise<void>,
  expect: (lines: string[]) => boolean,
): Promise<{ lines: string[]; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [BIN, "read", "--follow", ...args], {
    env: { ...process.env, ...env(base, { PI_ROOMS_CLIENT_TOKEN: TOKEN }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) lines.push(line);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 20_000;
  const waitFor = async (predicate: () => boolean) => {
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out; stdout so far:\n${lines.join("\n")}\nstderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const write = (line: string) => lines.push(line);
  await waitFor(() => lines.length > 0 || stderr.includes("following"));
  await during(write);
  await waitFor(() => expect(lines));

  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  const code = await exited;
  return { lines, stderr, code };
}

test("read --follow streams one JSON object per post, flushed as it happens", async () => {
  const { paths, base, room, lane } = seeded();

  const { lines, stderr, code } = await follow(
    base,
    ["--room", room, "--as", OPERATOR],
    async () => {
      // Written by a lane while the stream is open: the CLI must pick it up from
      // the file, because there is no event for "a file under $HOME changed".
      appendPost(paths, room, {
        id: randomUUID(),
        from: lane,
        text: "arrived while you were watching",
        sentAt: new Date().toISOString(),
        recipients: [OPERATOR],
      });
    },
    (seen) => seen.some((line) => line.includes("arrived while you were watching")),
  );

  assert.equal(code, 0, `SIGTERM is a clean stop, not a stack trace. stderr:\n${stderr}`);
  assert.match(stderr, /following/, "the human-facing preamble goes to stderr");
  const parsed = lines.map((line) => JSON.parse(line));
  assert.ok(parsed.every((entry) => typeof entry.type === "string"), "stdout is pure NDJSON");
  const post = parsed.find((entry) => entry.type === "post");
  assert.equal(post.seq, 1);
  assert.equal(post.from, lane);
  assert.equal(post.room, room);
  assert.match(stderr, /stopped following/, "and it says where it stopped");
});

test("read --follow reports a gap instead of resequencing silently", async () => {
  // A corrupt line consumes a seq without being returned by `readPosts` — the
  // documented outcome of a client that appended without a trailing newline. The
  // stream must say the posts are missing, not close the hole and pretend #3 was #4.
  const { paths, base, room } = seeded();
  const now = new Date().toISOString();
  for (const text of ["one", "two"]) {
    appendPost(paths, room, { id: randomUUID(), from: OPERATOR, text, sentAt: now, recipients: ["leader-lane"] });
  }
  fs.appendFileSync(path.join(paths.rooms, room, "log.jsonl"), "not-json-merged-post\n");
  appendPost(paths, room, {
    id: randomUUID(),
    from: OPERATOR,
    text: "after the gap",
    sentAt: now,
    recipients: ["leader-lane"],
  });

  const { lines, code } = await follow(
    base,
    ["--room", room, "--since", "2"],
    async () => {},
    (seen) => seen.some((line) => line.includes("after the gap")),
  );

  assert.equal(code, 0);
  const parsed = lines.map((line) => JSON.parse(line));
  const gap = parsed[0];
  assert.equal(gap.type, "gap", "the first line is the gap, before the post that exposed it");
  assert.equal(gap.after, 2);
  assert.equal(gap.next, 4);
  assert.equal(gap.missed, 1);
  assert.match(gap.note, /did not skip them silently/);

  const posts = parsed.filter((entry) => entry.type === "post");
  assert.deepEqual(posts.map((p) => p.seq), [4], "the numbers are the store's, not a local count");
  assert.ok(!parsed.some((entry) => entry.seq === 3), "no post is invented for the missing line");
});

test("read --follow exits on stdout EPIPE, as it does when the pane closes", async () => {
  const { paths, base, room } = seeded();
  appendPost(paths, room, {
    id: randomUUID(),
    from: OPERATOR,
    text: "the line whose reader will go away",
    sentAt: new Date().toISOString(),
    recipients: ["leader-lane"],
  });

  const child = spawn(process.execPath, [BIN, "read", "--room", room, "--follow"], {
    env: { ...process.env, ...env(base) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Wait for the follower to emit its first post, then take the pipe away.
  const deadline = Date.now() + 15_000;
  while (!stdout.includes("the line whose reader will go away")) {
    assert.ok(Date.now() < deadline, `the follower never emitted a line. stderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Destroying the read end closes the pipe. A closed stdout raises no event by
  // itself — only the *next* write does — so a post is appended to make the
  // follower write again, which is exactly what happens when a pane closes and a
  // message arrives a moment later.
  child.stdout.destroy();
  appendPost(paths, room, {
    id: randomUUID(),
    from: OPERATOR,
    text: "written into a pipe nobody is reading",
    sentAt: new Date().toISOString(),
    recipients: ["leader-lane"],
  });

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });

  assert.equal(signal, null, "the follower exited on its own; it did not have to be killed");
  assert.equal(code, 0, "a closed pipe is a normal end of stream, not a failure");
  assert.doesNotMatch(stderr, /\bat .+:\d+:\d+/, `it exits without a stack trace:\n${stderr}`);
});

// ---------------------------------------------------------------------------
// C9 — the machine-readable contract
// ---------------------------------------------------------------------------

test("--json emits one parseable object on every verb", () => {
  const { paths, base, room, lane } = seeded();
  const cases: Array<[string, string[]]> = [
    ["who", ["who", "--json"]],
    ["list", ["list", "--json"]],
    ["participants", ["participants", "--json"]],
    ["presence", ["presence", "--json"]],
    ["read-room", ["read", "--room", room, "--json"]],
    ["post", ["post", "--room", room, "json post", "--json"]],
    ["dm", ["dm", "--to", lane, "json dm", "--json"]],
    ["join", ["join", "--room", room, "--json"]],
  ];
  for (const [label, args] of cases) {
    const run = operator(base, args);
    assert.equal(run.status, 0, `${label}: ${run.stderr}`);
    assert.ok(run.json != null, `${label} emitted a parseable object on stdout`);
    assert.equal(typeof run.json.verb, "string", `${label} names its verb`);
  }

  // ack needs an id, so it is exercised against a real message.
  const id = randomUUID();
  deliver(paths, { id, from: lane, to: [OPERATOR], text: "ack me", sentAt: new Date().toISOString() });
  const ack = operator(base, ["ack", "--as", OPERATOR, "--id", id, "--json"]);
  assert.equal(ack.status, 0, ack.stderr);
  assert.equal(ack.json.verb, "ack");

  // A failure is still one object, so a caller parses rather than scrapes stderr.
  const bad = rooms(["post", "--room", room, "x", "--json"], env(base));
  assert.equal(bad.status, 2);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /needs --as/);
});

test("--json on the inbox names the ids the caller will ack", () => {
  const { paths, base } = seeded();
  const id = randomUUID();
  deliver(paths, { id, from: "leader-lane", to: [OPERATOR], text: "which id?", sentAt: new Date().toISOString() });
  const run = operator(base, ["read", "--as", OPERATOR, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.json.delivered, [id], "the id ack takes is in the read output");
});

test("help documents identity, the token's real job, and provenance's limits", () => {
  const help = rooms(["--help"], env(tempPaths().base)).stdout;
  for (const verb of ["who", "list", "read", "post", "dm", "ack", "join", "participants", "presence"]) {
    assert.match(help, new RegExp(`rooms ${verb}\\b`), `${verb} is documented`);
  }
  assert.match(help, /lock, not a credential/i, "the token is not described as authentication");
  assert.match(help, /authenticates nobody/i);
  assert.match(help, /self-declared/i, "provenance is described as a signal");
  assert.match(help, /never a control/i);
  // Slice 1 excludes these, and the help must not advertise them.
  assert.doesNotMatch(help, /rooms create\b/, "no create verb in slice 1");
  assert.doesNotMatch(help, /rooms pins\b/, "no pins verb in slice 1");
});

test("no protocol.json is written — schema publication is stubbed out of slice 1", () => {
  const { paths, base, room } = seeded();
  assert.equal(operator(base, ["post", "--room", room, "no schema please"]).status, 0);
  assert.equal(fs.existsSync(path.join(paths.base, "protocol.json")), false);
  // And nothing invented a directory the live fleet does not already have.
  const entries = fs.readdirSync(paths.base).sort();
  for (const entry of entries) {
    assert.ok(
      ["inbox", "receipts", "registry", "rooms", "participants", "presence"].includes(entry),
      `unexpected store entry ${entry}`,
    );
  }
});
