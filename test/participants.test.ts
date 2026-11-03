/**
 * Participant tests.
 *
 * A human is a principal with a mailbox and no process. Two properties carry
 * that: the identity record lives in `participants/` where the liveness pruner
 * never looks, and the name it holds cannot be granted to a lane. Everything
 * here is a plain function over a temp directory — the live store at
 * `~/.pi/agent/rooms` is never touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  claimName,
  createParticipant,
  isReservedName,
  isValidName,
  listAgents,
  listParticipants,
  readParticipant,
  register,
  resolvePaths,
  saveParticipant,
  type Participant,
  type Registration,
} from "../src/store.ts";

function tempPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-part-"));
  return resolvePaths(base);
}

function record(overrides: Partial<Participant> = {}): Participant {
  return {
    name: "operator",
    kind: "human",
    displayName: null,
    createdBy: "overlord",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function reg(name: string, pid = process.pid): Registration {
  return {
    name,
    pid,
    cwd: "/work/x",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// P1 — the record and the loader
// ---------------------------------------------------------------------------

test("a participant record round-trips through participants/<name>.json", () => {
  const paths = tempPaths();
  const saved = saveParticipant(paths, {
    ...record(),
    displayName: "Alex",
    client: { id: "c-1", label: "herdr-plugin", tokenSha256: "abc123" },
  });
  assert.equal(saved.name, "operator");

  // On disk where the design says, not in registry/.
  assert.ok(fs.existsSync(path.join(paths.participants, "operator.json")));
  assert.equal(fs.existsSync(path.join(paths.registry, "operator.json")), false);

  const read = readParticipant(paths, "operator");
  assert.ok(read != null);
  assert.equal(read.kind, "human");
  assert.equal(read.displayName, "Alex");
  assert.equal(read.createdBy, "overlord");
  assert.deepEqual(read.client, { id: "c-1", label: "herdr-plugin", tokenSha256: "abc123" });
  assert.deepEqual(listParticipants(paths).map((p) => p.name), ["operator"]);
});

test("displayName is arbitrary text and never reaches the path", () => {
  const paths = tempPaths();
  // Spaces, unicode, slashes and traversal sequences: all legal in a display
  // name and all irrelevant to where the file lands.
  for (const displayName of ["Alex", "Al ex", "Ωperator 東京", "../../etc/passwd", "a/b\\c"]) {
    const saved = saveParticipant(paths, record({ displayName }));
    assert.equal(saved.displayName, displayName);
    assert.ok(fs.existsSync(path.join(paths.participants, "operator.json")));
    assert.equal(readParticipant(paths, "operator")?.displayName, displayName);
  }
  // Only the one record exists: a display name did not create a second file.
  assert.equal(fs.readdirSync(paths.participants).length, 1);
});

test("a participant name failing NAME_RE is refused on write", () => {
  const paths = tempPaths();
  for (const name of ["Operator", "human:operator", "alex@example.com", "-lead", "with space", ""]) {
    assert.equal(isValidName(name), false, `${JSON.stringify(name)} is not a valid name`);
    assert.throws(() => saveParticipant(paths, record({ name })), /not a valid rooms name/);
  }
  // And nothing was written for any of them.
  assert.equal(fs.existsSync(paths.participants), false);
});

test("a corrupt participant file does not throw and is not a reservation", () => {
  const paths = tempPaths();
  fs.mkdirSync(paths.participants, { recursive: true });
  fs.writeFileSync(path.join(paths.participants, "operator.json"), "{ not json at all");

  assert.doesNotThrow(() => readParticipant(paths, "operator"));
  assert.equal(readParticipant(paths, "operator"), null);
  assert.equal(isReservedName(paths, "operator"), false, "an unreadable record reserves nothing");
  assert.doesNotThrow(() => listParticipants(paths));
  assert.deepEqual(listParticipants(paths), []);
  // In particular the unreadable file is not deleted: losing an identity to a
  // parse error would be worse than ignoring it.
  assert.ok(fs.existsSync(path.join(paths.participants, "operator.json")));
});

test("a partial participant record is absent rather than half-trusted", () => {
  const paths = tempPaths();
  fs.mkdirSync(paths.participants, { recursive: true });
  const file = path.join(paths.participants, "operator.json");
  // Missing kind.
  fs.writeFileSync(file, JSON.stringify({ name: "operator", createdBy: "x", createdAt: "y" }));
  assert.equal(isReservedName(paths, "operator"), false);
  // A record whose stored name disagrees with its file name reserves neither.
  fs.writeFileSync(file, JSON.stringify({ name: "someone-else", kind: "human" }));
  assert.equal(isReservedName(paths, "operator"), false);
  assert.equal(readParticipant(paths, "someone-else"), null);
  // A well-formed record does reserve.
  fs.writeFileSync(file, JSON.stringify(record()));
  assert.equal(isReservedName(paths, "operator"), true);
});

test("an unknown kind is not rejected", () => {
  const paths = tempPaths();
  saveParticipant(paths, record({ kind: "service-account" }));
  assert.equal(readParticipant(paths, "operator")?.kind, "service-account");
  assert.equal(isReservedName(paths, "operator"), true, "any kind reserves its name");
});

test("createParticipant defaults to a human, and is idempotent", () => {
  const paths = tempPaths();
  const created = createParticipant(paths, {
    name: "operator",
    displayName: "Alex",
    createdBy: "overlord",
    client: { id: "c-1", label: "herdr-plugin" },
  });
  assert.equal(created.kind, "human");
  assert.equal(created.displayName, "Alex");

  const again = createParticipant(paths, { name: "operator", createdBy: "someone-else" });
  assert.equal(again.createdBy, "overlord", "an existing record is returned, not overwritten");
  assert.equal(listParticipants(paths).length, 1);
});

// ---------------------------------------------------------------------------
// P2 — the reservation, at the seam
// ---------------------------------------------------------------------------

test("claimName never grants a reserved participant name", () => {
  const paths = tempPaths();
  saveParticipant(paths, record());

  const claimed = claimName(paths, "operator", process.pid);
  assert.notEqual(claimed, "operator", "the human's name is not handed to a lane");
  assert.ok(claimed.startsWith("operator-"), `suffixed variant, got ${claimed}`);
  assert.ok(isValidName(claimed), "the suffixed variant is still a valid name");
  assert.equal(isReservedName(paths, claimed), false, "and it is not itself reserved");
});

test("claimName still grants an unreserved name unsuffixed", () => {
  const paths = tempPaths();
  saveParticipant(paths, record());
  // The unsuffixed grant is what `lane-identity` documents for non-reserved
  // names, and the reservation must not turn every name into a collision.
  assert.equal(claimName(paths, "dxdb-core", process.pid), "dxdb-core");
  assert.equal(claimName(paths, "dxdb-core", process.pid), "dxdb-core", "stable on repeat");
});

test("a corrupted reservation does not block the name forever", () => {
  const paths = tempPaths();
  fs.mkdirSync(paths.participants, { recursive: true });
  fs.writeFileSync(path.join(paths.participants, "operator.json"), "garbage");
  assert.equal(claimName(paths, "operator", process.pid), "operator");
});

test("register refuses a reserved participant name and says where it is reserved", () => {
  const paths = tempPaths();
  saveParticipant(paths, record());
  assert.throws(
    () => register(paths, reg("operator")),
    (error: Error) => {
      assert.match(error.message, /reserved by a human participant/);
      assert.ok(error.message.includes(paths.participants), "the message names the directory");
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(paths.registry, "operator.json")), false);
});

test("register still writes an unreserved registration, and liveness leaves the record alone", () => {
  const paths = tempPaths();
  saveParticipant(paths, record());
  register(paths, reg("alpha"));
  assert.ok(fs.existsSync(path.join(paths.registry, "alpha.json")));

  // The pruner that makes `registry/` unsafe for humans: it unlinks dead
  // entries, but has no opinion on participants.
  register(paths, reg("ghost", 999999));
  assert.deepEqual(listAgents(paths).map((a) => a.name), ["alpha"]);
  assert.equal(fs.existsSync(path.join(paths.registry, "ghost.json")), false);
  assert.equal(readParticipant(paths, "operator")?.name, "operator", "identity survives the prune");
});

test("a reservation outlives the process that would have taken it", () => {
  const paths = tempPaths();
  saveParticipant(paths, record());
  // A different pid, as another lane would be.
  for (const pid of [1, 2, process.pid + 1]) {
    const claimed = claimName(paths, "operator", pid);
    assert.notEqual(claimed, "operator", `pid ${pid} must not take the human's name`);
    assert.ok(isValidName(claimed));
  }
});
