/**
 * Store-level tests. No pi process needed: everything here is a plain function
 * over a temp directory, which is the point of keeping the store separate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  addRoomMember,
  appendPost,
  appendRoomEvent,
  archive,
  claimName,
  createRoom,
  defaultName,
  deliver,
  discardQueuedRoomMessages,
  drain,
  findReceived,
  isAlive,
  isValidName,
  isValidRoom,
  LEAVE_EVENT_TEXT,
  listAgents,
  listRooms,
  readPosts,
  readRoom,
  register,
  removeRoomMember,
  resolvePaths,
  roomSeq,
  sanitize,
  saveRoom,
  slugify,
  uniqueMembers,
  unregister,
  type Delivery,
  type Registration,
  type Room,
} from "../src/store.ts";

function tempPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-"));
  return resolvePaths(base);
}

function reg(name: string, cwd = "/work/x"): Registration {
  return {
    name,
    pid: process.pid,
    cwd,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("names and rooms are validated", () => {
  assert.equal(isValidName("lane-alpha"), true);
  assert.equal(isValidName("Lane Alpha"), false);
  assert.equal(isValidName("-lead"), false);
  assert.equal(isValidRoom("dxdb"), true);
  assert.equal(isValidRoom("dxdb/worktrees"), false);
});

test("slugify collapses punctuation", () => {
  assert.equal(slugify("m2-core (deleted)"), "m2-core-deleted");
  assert.equal(slugify("!!!"), "agent");
});

test("sanitize strips control characters and caps length", () => {
  assert.equal(sanitize("a\u0000b\u001bc"), "abc");
  const long = sanitize("x".repeat(5000));
  assert.ok(long.length < 5000 + 200);
  assert.match(long, /truncated/);
});

test("defaultName prefers the operator's name, else is stable per directory", () => {
  assert.equal(defaultName("/work/a", { PI_ROOMS_NAME: "sysop-leader" }), "sysop-leader");
  assert.equal(defaultName("/work/a", { PI_AGENT_NAME: "plugin-eval" }), "plugin-eval");
  const a = defaultName("/work/a", {});
  const b = defaultName("/work/a", {});
  const c = defaultName("/work/b", {});
  assert.equal(a, b, "same directory yields the same name");
  assert.notEqual(a, c, "different directories yield different names");
  assert.ok(isValidName(a));
});

test("presence lists live agents and prunes dead ones", () => {
  const paths = tempPaths();
  register(paths, reg("alpha"));
  register(paths, { ...reg("ghost"), pid: 999999 });
  const names = listAgents(paths).map((a) => a.name);
  assert.deepEqual(names, ["alpha"]);
  assert.equal(fs.existsSync(path.join(paths.registry, "ghost.json")), false);
});

test("a live name is never taken over; the claimant is suffixed", () => {
  const paths = tempPaths();
  register(paths, reg("alpha"));
  const claimed = claimName(paths, "alpha", process.pid + 1);
  assert.notEqual(claimed, "alpha");
  assert.ok(claimed.startsWith("alpha-"));
  // Re-claiming an unregistered name returns it unchanged.
  assert.equal(claimName(paths, "beta", process.pid), "beta");
});

test("unregister removes presence", () => {
  const paths = tempPaths();
  register(paths, reg("alpha"));
  unregister(paths, "alpha");
  assert.deepEqual(listAgents(paths), []);
});

test("a direct message is delivered once and archived for reply lookup", () => {
  const paths = tempPaths();
  const message: Delivery = {
    id: "11111111-2222-3333-4444-555555555555",
    from: "alpha",
    to: ["beta", "gamma"],
    text: "hello",
    sentAt: new Date().toISOString(),
  };
  const written = deliver(paths, message);
  assert.deepEqual(written.sort(), ["beta", "gamma"]);

  const pendingBeta = drain(paths, "beta");
  assert.equal(pendingBeta.length, 1);
  assert.equal(pendingBeta[0].message.text, "hello");

  archive(paths, "beta", pendingBeta[0].file, message);
  assert.equal(drain(paths, "beta").length, 0, "archived message is no longer pending");
  assert.ok(findReceived(paths, "beta", message.id) != null, "reply_all can still resolve it");

  // The sender never receives their own message.
  assert.equal(drain(paths, "alpha").length, 0);
});

test("reply_all resolves the recipient set from the archived message", () => {
  const paths = tempPaths();
  const original: Delivery = {
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    from: "alpha",
    to: ["beta", "gamma"],
    text: "question",
    sentAt: new Date().toISOString(),
  };
  deliver(paths, original);
  for (const entry of drain(paths, "beta")) archive(paths, "beta", entry.file, entry.message);

  const found = findReceived(paths, "beta", original.id);
  assert.ok(found != null);
  const replyTo = uniqueMembers([found.from, ...found.to]).filter((n) => n !== "beta");
  assert.deepEqual(replyTo, ["alpha", "gamma"], "the sender is included even though it is not in `to`");
});

test("findReceived returns null for an unknown id", () => {
  const paths = tempPaths();
  assert.equal(findReceived(paths, "beta", "deadbeef"), null);
});

test("a room keeps membership and append-only history", () => {
  const paths = tempPaths();
  const room: Room = {
    name: "dxdb",
    members: ["lead", "core", "testkit"],
    createdBy: "lead",
    createdAt: new Date().toISOString(),
  };
  createRoom(paths, room);
  assert.deepEqual(readRoom(paths, "dxdb")?.members, ["lead", "core", "testkit"]);

  assert.equal(appendPost(paths, "dxdb", { from: "lead", text: "kickoff", sentAt: new Date().toISOString(), recipients: ["core", "testkit"] }), 1);
  assert.equal(appendPost(paths, "dxdb", { from: "core", text: "started", sentAt: new Date().toISOString(), recipients: ["lead", "testkit"] }), 2);

  const all = readPosts(paths, "dxdb");
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((p) => p.seq), [1, 2]);
  assert.deepEqual(all.map((p) => p.text), ["kickoff", "started"]);

  assert.equal(roomSeq(paths, "dxdb"), 2);
});

test("readPosts since/limit semantics let a late joiner catch up incrementally", () => {
  const paths = tempPaths();
  createRoom(paths, { name: "r", members: ["a"], createdBy: "a", createdAt: new Date().toISOString() });
  for (let i = 1; i <= 6; i += 1) {
    appendPost(paths, "r", { from: "a", text: `m${i}`, sentAt: new Date().toISOString(), recipients: [] });
  }
  assert.deepEqual(readPosts(paths, "r", 0).map((p) => p.text), ["m1", "m2", "m3", "m4", "m5", "m6"]);
  assert.deepEqual(readPosts(paths, "r", 4).map((p) => p.text), ["m5", "m6"]);
  assert.deepEqual(readPosts(paths, "r", 0, 2).map((p) => p.text), ["m5", "m6"], "limit keeps the newest");
  assert.deepEqual(readPosts(paths, "r", 6), [], "nothing new past the tail");
});

test("reading an unknown room yields empty history rather than throwing", () => {
  const paths = tempPaths();
  assert.deepEqual(readPosts(paths, "nope"), []);
  assert.equal(readRoom(paths, "nope"), null);
  assert.deepEqual(listRooms(paths), []);
});

test("joining rewrites membership without creating a second room file", () => {
  const paths = tempPaths();
  const room: Room = { name: "r", members: ["a", "b"], createdBy: "a", createdAt: new Date().toISOString() };
  createRoom(paths, room);
  room.members = uniqueMembers([...room.members, "c", "c", "  "]);
  saveRoom(paths, room);
  assert.deepEqual(readRoom(paths, "r")?.members, ["a", "b", "c"]);
  assert.equal(listRooms(paths).length, 1);
});

test("uniqueMembers drops blanks, duplicates and invalid names", () => {
  assert.deepEqual(uniqueMembers(["a", "a", "", " B ", "b", "bad name", "c"]), ["a", "b", "c"]);
});

test("concurrent room appends do not lose posts", () => {
  const paths = tempPaths();
  createRoom(paths, { name: "r", members: ["a"], createdBy: "a", createdAt: new Date().toISOString() });
  const child = (label: string) => {
    for (let i = 0; i < 20; i += 1) {
      appendPost(paths, "r", { from: label, text: `${label}${i}`, sentAt: new Date().toISOString(), recipients: [] });
    }
  };
  child("x");
  child("y");
  const posts = readPosts(paths, "r", 0, 1000);
  assert.equal(posts.length, 40);
  assert.deepEqual(posts.map((p) => p.seq), Array.from({ length: 40 }, (_, i) => i + 1));
});

test("isAlive recognises this process and rejects nonsense", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(999999), false);
  assert.equal(isAlive(0), false);
});

// ---------------------------------------------------------------------------
// Leaving a room (FT-24)
// ---------------------------------------------------------------------------

function seededRoom(paths: ReturnType<typeof tempPaths>, members: string[]): Room {
  const room: Room = {
    name: "r",
    members,
    createdBy: members[0] ?? "a",
    createdAt: new Date().toISOString(),
  };
  createRoom(paths, room);
  return room;
}

function roomMessage(id: string, from: string, to: string[], room: string, text = "hi"): Delivery {
  return {
    id,
    from,
    to,
    text,
    sentAt: new Date().toISOString(),
    room,
    roomSeq: 1,
  };
}

test("leaving removes membership, and the room persists when it empties", () => {
  const paths = tempPaths();
  const room = seededRoom(paths, ["a", "b"]);

  assert.equal(removeRoomMember(paths, room, "b"), true);
  assert.deepEqual(readRoom(paths, "r")?.members, ["a"]);
  assert.equal(removeRoomMember(paths, readRoom(paths, "r")!, "b"), false, "already out: no change");

  assert.equal(removeRoomMember(paths, readRoom(paths, "r")!, "a"), true);
  assert.deepEqual(readRoom(paths, "r")?.members, [], "the last member may leave");
  assert.equal(listRooms(paths).length, 1, "an empty room stays on disk, so it stays joinable");
});

test("joining reports a change only the first time", () => {
  const paths = tempPaths();
  const room = seededRoom(paths, ["a"]);

  assert.equal(addRoomMember(paths, room, "b"), true);
  assert.equal(addRoomMember(paths, readRoom(paths, "r")!, "b"), false, "a repeated join is a no-op");
  assert.deepEqual(readRoom(paths, "r")?.members, ["a", "b"]);
  assert.equal(addRoomMember(paths, readRoom(paths, "r")!, "bad name"), false, "invalid names are refused");
});

test("a room event is history with no recipients, sharing the sequence space", () => {
  const paths = tempPaths();
  seededRoom(paths, ["a", "b"]);

  assert.equal(appendRoomEvent(paths, "r", "b", LEAVE_EVENT_TEXT), 1);
  assert.equal(
    appendPost(paths, "r", { from: "a", text: "carrying on", sentAt: new Date().toISOString(), recipients: [] }),
    2,
  );

  const posts = readPosts(paths, "r");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].kind, "event");
  assert.deepEqual(posts[0].recipients, [], "an event is delivered to nobody");
  assert.equal(posts[0].from, "b");
  assert.equal(posts[0].text, LEAVE_EVENT_TEXT);
  assert.equal(posts[1].kind, undefined, "an ordinary post keeps the absent default");

  // Nothing was written into anyone's inbox by the event.
  assert.deepEqual(drain(paths, "a"), []);
  assert.deepEqual(drain(paths, "b"), []);
});

test("discarding queued room messages touches only that agent, only that room, never read/", () => {
  const paths = tempPaths();
  seededRoom(paths, ["a", "b", "g"]);
  createRoom(paths, { name: "other", members: ["a", "b"], createdBy: "a", createdAt: new Date().toISOString() });

  // Three queued room-r messages for b, one of which is then delivered/archived.
  deliver(paths, roomMessage("11111111-1111-1111-1111-111111111111", "a", ["b"], "r"));
  deliver(paths, roomMessage("22222222-2222-2222-2222-222222222222", "a", ["b"], "r"));
  deliver(paths, roomMessage("33333333-3333-3333-3333-333333333333", "a", ["b", "g"], "r"));
  // A second room's post, and a DM, both queued for b.
  deliver(paths, roomMessage("44444444-4444-4444-4444-444444444444", "a", ["b"], "other"));
  deliver(paths, {
    id: "55555555-5555-5555-5555-555555555555",
    from: "a",
    to: ["b"],
    text: "direct",
    sentAt: new Date().toISOString(),
  });

  const archived = drain(paths, "b").find(
    (entry) => entry.message.id === "22222222-2222-2222-2222-222222222222",
  )!;
  archive(paths, "b", archived.file, archived.message);
  assert.equal(drain(paths, "b").length, 4, "four queued for b before the discard");

  assert.equal(discardQueuedRoomMessages(paths, "b", "r"), 2);

  const left = drain(paths, "b").map((entry) => entry.message.id).sort();
  assert.deepEqual(left, [
    "44444444-4444-4444-4444-444444444444",
    "55555555-5555-5555-5555-555555555555",
  ]);
  assert.ok(
    fs.existsSync(path.join(paths.inbox, "b", "read", "22222222-2222-2222-2222-222222222222.json")),
    "the read/ archive survives the discard",
  );
  // g was never the leaver, so its inbox is untouched.
  assert.equal(drain(paths, "g").length, 1);
  assert.equal(discardQueuedRoomMessages(paths, "b", "r"), 0, "discarding twice is harmless");
});
