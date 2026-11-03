/**
 * Presence tests.
 *
 * A human has no pid, so presence is a lease written by their client and
 * expired on read. Every expectation here is a function of the record and an
 * injected clock — no `Date` mocking, no sleeping, no probe of any process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createParticipant,
  listPresence,
  readPresence,
  resolvePaths,
  writePresence,
  PRESENCE_GRACE_MS,
  type Presence,
} from "../src/store.ts";

function tempPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-pres-"));
  return resolvePaths(base);
}

/** A fixed instant, so nothing in this file depends on how long the suite takes. */
const NOW = Date.parse("2026-11-02T18:00:00.000Z");
const LEASE_MS = 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A heartbeat written `ageMs` ago, with a 60s lease. */
function heartbeat(ageMs: number, overrides: Partial<Presence> = {}): Presence {
  return {
    name: "operator",
    state: "online",
    lastSeenAt: iso(NOW - ageMs),
    leaseUntil: iso(NOW - ageMs + LEASE_MS),
    client: "herdr-plugin",
    note: null,
    ...overrides,
  };
}

function withOperator(): ReturnType<typeof tempPaths> {
  const paths = tempPaths();
  createParticipant(paths, { name: "operator", createdBy: "overlord" });
  return paths;
}

test("a live lease reads online", () => {
  const paths = tempPaths();
  writePresence(paths, heartbeat(10 * 1000));
  const view = readPresence(paths, "operator", NOW);
  assert.equal(view.state, "online");
  assert.equal(view.declared, "online");
  assert.equal(view.present, true);
  assert.equal(view.ageMs, 10 * 1000);
  assert.equal(view.client, "herdr-plugin");
});

test("a lease expiring exactly now is not online", () => {
  const paths = tempPaths();
  // leaseUntil == now is the boundary: the lease did not survive to this instant.
  writePresence(paths, {
    name: "operator",
    state: "online",
    lastSeenAt: iso(NOW - LEASE_MS),
    leaseUntil: iso(NOW),
  });
  assert.equal(readPresence(paths, "operator", NOW).state, "away");
  assert.equal(readPresence(paths, "operator", NOW - 1).state, "online");
});

test("between lease expiry and the grace window the state is away", () => {
  const paths = tempPaths();
  // Last heartbeat 10 minutes ago: the 60s lease is long gone, the person is
  // not. `away (10m)` is the render this produces.
  writePresence(paths, heartbeat(10 * 60 * 1000));
  const view = readPresence(paths, "operator", NOW);
  assert.equal(view.state, "away");
  assert.equal(view.declared, "online", "derived is distinguishable from declared");
});

test("past lease plus grace the state is offline", () => {
  const paths = tempPaths();
  writePresence(paths, heartbeat(PRESENCE_GRACE_MS + 1000));
  const view = readPresence(paths, "operator", NOW);
  assert.equal(view.state, "offline");
  assert.equal(view.present, true, "the record exists; the person declared something once");
});

test("the grace boundary is inclusive at the constant and excludes just past it", () => {
  const paths = tempPaths();
  writePresence(paths, heartbeat(PRESENCE_GRACE_MS));
  assert.equal(readPresence(paths, "operator", NOW).state, "away");
  writePresence(paths, heartbeat(PRESENCE_GRACE_MS + 1));
  assert.equal(readPresence(paths, "operator", NOW).state, "offline");
});

test("a missing presence file reads unknown, never offline", () => {
  const paths = tempPaths();
  const view = readPresence(paths, "operator", NOW);
  assert.equal(view.state, "unknown");
  assert.equal(view.present, false);
  assert.equal(view.ageMs, null);
  assert.equal(view.lastSeenAt, null);
  // Absence is not evidence a human is gone, so nothing was written either.
  assert.equal(fs.existsSync(paths.presence), false);
});

test("an explicit away survives a live lease", () => {
  const paths = tempPaths();
  // A fresh heartbeat, but the person declared they stepped out.
  writePresence(paths, heartbeat(1000, { state: "away" }));
  const view = readPresence(paths, "operator", NOW);
  assert.equal(view.state, "away");
  assert.equal(view.declared, "away");
});

test("an explicit offline is not overruled by a live lease", () => {
  const paths = tempPaths();
  writePresence(paths, heartbeat(1000, { state: "offline" }));
  assert.equal(readPresence(paths, "operator", NOW).state, "offline");
});

test("a lease with no lastSeenAt still expires from the lease instant", () => {
  const paths = tempPaths();
  const file = path.join(paths.presence, "operator.json");
  fs.mkdirSync(paths.presence, { recursive: true });
  // Only a lease: the grace window is measured from the last thing the record
  // said about the human, so this still derives rather than reading unknown.
  fs.writeFileSync(file, JSON.stringify({ name: "operator", state: "online", leaseUntil: iso(NOW + 1000) }));
  assert.equal(readPresence(paths, "operator", NOW).state, "online");
  fs.writeFileSync(file, JSON.stringify({ name: "operator", state: "online", leaseUntil: iso(NOW - 1000) }));
  assert.equal(readPresence(paths, "operator", NOW).state, "away");
  fs.writeFileSync(
    file,
    JSON.stringify({ name: "operator", state: "online", leaseUntil: iso(NOW - PRESENCE_GRACE_MS - 1000) }),
  );
  assert.equal(readPresence(paths, "operator", NOW).state, "offline");
});

test("an explicit unknown is not a licence to infer a state from the clock", () => {
  const paths = tempPaths();
  // A live lease alongside a declared `unknown` stays unknown.
  writePresence(paths, heartbeat(1000, { state: "unknown" }));
  assert.equal(readPresence(paths, "operator", NOW).state, "unknown");
});

test("a corrupt presence file reads unknown and does not throw", () => {
  const paths = tempPaths();
  fs.mkdirSync(paths.presence, { recursive: true });
  const file = path.join(paths.presence, "operator.json");
  fs.writeFileSync(file, "{ this is not json");
  assert.doesNotThrow(() => readPresence(paths, "operator", NOW));
  assert.equal(readPresence(paths, "operator", NOW).state, "unknown");

  // A record with no usable complaint at all — an unrecognised state and no
  // timestamps — is `unknown`, not `offline`: there is no evidence to make a
  // claim about a person from, exactly as with a missing file.
  fs.writeFileSync(file, JSON.stringify({ name: "operator", state: "banana" }));
  assert.doesNotThrow(() => readPresence(paths, "operator", NOW));
  assert.equal(readPresence(paths, "operator", NOW).state, "unknown");

  // A valid state with no timestamps is equally underdetermined: `online` cannot
  // be derived without a lease, so it degrades to `unknown` rather than guessing.
  fs.writeFileSync(file, JSON.stringify({ name: "operator", state: "online" }));
  assert.equal(readPresence(paths, "operator", NOW).state, "unknown");
});

test("readPresence is pure: two calls at one instant agree and nothing is written", () => {
  const paths = tempPaths();
  writePresence(paths, heartbeat(10 * 60 * 1000));
  const before = fs.readdirSync(paths.presence).sort();
  const raw = fs.readFileSync(path.join(paths.presence, "operator.json"), "utf8");

  const first = readPresence(paths, "operator", NOW);
  const second = readPresence(paths, "operator", NOW);
  assert.deepEqual(first, second, "same clock, same answer");
  assert.deepEqual(fs.readdirSync(paths.presence).sort(), before, "no file created");
  assert.equal(fs.readFileSync(path.join(paths.presence, "operator.json"), "utf8"), raw, "no rewrite");
});

test("expiry advances with the clock and never moves backwards", () => {
  const paths = tempPaths();
  writePresence(paths, heartbeat(10 * 1000));
  assert.equal(readPresence(paths, "operator", NOW).state, "online");
  assert.equal(readPresence(paths, "operator", NOW + 10 * 60 * 1000).state, "away");
  assert.equal(readPresence(paths, "operator", NOW + 60 * 60 * 1000).state, "offline");
});

test("writePresence refuses an invalid name and an unknown state", () => {
  const paths = tempPaths();
  assert.throws(() => writePresence(paths, heartbeat(0, { name: "Operator" })), /not a valid rooms name/);
  assert.throws(
    () => writePresence(paths, heartbeat(0, { state: "live" as never })),
    /must be online, away, offline or unknown/,
  );
  assert.equal(fs.existsSync(paths.presence), false);
});

test("presence is never probed for a pid", () => {
  const paths = tempPaths();
  // A record may carry stray junk fields; nothing here resolves liveness from them.
  writePresence(paths, { ...heartbeat(1000), pid: 999999 } as never);
  const view = readPresence(paths, "operator", NOW);
  assert.equal(view.state, "online");
  assert.equal((view as unknown as { pid?: number }).pid, undefined, "the view carries no pid");
  assert.equal(fs.existsSync(path.join(paths.registry, "operator.json")), false, "no registration written");
});

test("listPresence pairs every participant with its derived state", () => {
  const paths = withOperator();
  createParticipant(paths, { name: "auditor", kind: "human", createdBy: "overlord" });
  writePresence(paths, heartbeat(10 * 1000));

  const listed = listPresence(paths, NOW);
  assert.deepEqual(listed.map((entry) => entry.participant.name), ["auditor", "operator"]);
  const byName = Object.fromEntries(listed.map((entry) => [entry.participant.name, entry.presence.state]));
  assert.deepEqual(byName, { auditor: "unknown", operator: "online" });
});
