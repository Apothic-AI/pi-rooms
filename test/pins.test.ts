/**
 * Pin tests.
 *
 * The interesting property is that a pin can never silently hand one lane's
 * identity to another. That is what the proc-identity stamp is for, and it is
 * what these tests exercise: not just "does a pin apply", but "does a pin stop
 * applying when the process behind the key changes".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  candidateKeys,
  claimPin,
  listPins,
  pinPath,
  readPinFile,
  releaseStalePin,
  resolvePin,
  writePinFile,
} from "../src/pins.ts";
import { procIdentity, register, resolvePaths, type Registration } from "../src/store.ts";

function tempPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-pin-"));
  return resolvePaths(base);
}

function registerAgent(paths: ReturnType<typeof tempPaths>, name: string, pid: number, cwd: string) {
  const entry: Registration = {
    name,
    pid,
    cwd,
    bootId: undefined,
    procId: procIdentity(pid) ?? undefined,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  register(paths, entry);
}

function writePins(paths: ReturnType<typeof tempPaths>, pins: Record<string, unknown>) {
  writePinFile(paths, { pins: pins as never });
}

test("no pin file means no pin", () => {
  const paths = tempPaths();
  assert.equal(resolvePin(paths, { cwd: "/work/x", pid: process.pid }), null);
});

test("candidate keys are ordered session, pane, cwd", () => {
  assert.deepEqual(
    candidateKeys({ sessionId: "s1", paneId: "wE:p1B", cwd: "/work/x", pid: 1 }),
    ["session:s1", "pane:wE:p1B", "cwd:/work/x"],
  );
  assert.deepEqual(candidateKeys({ cwd: "/work/x", pid: 1 }), ["cwd:/work/x"]);
});

test("a pane pin applies and is stamped with the claiming process", () => {
  const paths = tempPaths();
  writePins(paths, { "pane:wE:p1B": { name: "dxdb-core" } });

  const first = claimPin(paths, { paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(first?.name, "dxdb-core");
  assert.equal(first?.key, "pane:wE:p1B");
  assert.equal(first?.claimed, true, "first use claims it");

  const stamp = readPinFile(paths).pins["pane:wE:p1B"].procId;
  assert.equal(stamp, procIdentity(process.pid));

  // A second call by the same process is no longer a claim.
  const second = claimPin(paths, { paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(second?.name, "dxdb-core");
  assert.equal(second?.claimed, false);
});

test("a pin claimed by another process is NOT inherited by a new occupant", () => {
  const paths = tempPaths();
  // Simulate: the pin was claimed by a process that is now gone.
  writePins(paths, { "pane:wE:p1B": { name: "dxdb-core", procId: "123456:R" } });

  const resolved = resolvePin(paths, { paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(resolved?.name, "", "must not apply to this process");
  assert.equal(resolved?.rejected?.key, "pane:wE:p1B");
  assert.match(resolved!.rejected!.reason, /different process/);
});

test("a rejected higher-priority pin falls through to a lower one", () => {
  const paths = tempPaths();
  writePins(paths, {
    "pane:wE:p1B": { name: "old-occupant", procId: "123456:R" },
    "cwd:/work/x": { name: "fallback-name" },
  });
  const resolved = claimPin(paths, { paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(resolved?.name, "fallback-name");
  assert.equal(resolved?.key, "cwd:/work/x");
});

test("session pins outrank pane pins, because a pane id does not survive a move", () => {
  const paths = tempPaths();
  writePins(paths, {
    "session:s1": { name: "by-session" },
    "pane:wE:p1B": { name: "by-pane" },
  });
  const resolved = claimPin(paths, { sessionId: "s1", paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(resolved?.name, "by-session");
  assert.equal(resolved?.key, "session:s1");
});

test("an invalid pinned name is ignored rather than applied", () => {
  const paths = tempPaths();
  writePins(paths, { "pane:wE:p1B": { name: "Not A Valid Name" } });
  const resolved = resolvePin(paths, { paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(resolved?.name, "");
  assert.match(resolved!.rejected!.reason, /not a valid name/);
});

test("a malformed pin file is ignored, not fatal", () => {
  const paths = tempPaths();
  fs.mkdirSync(paths.base, { recursive: true });
  fs.writeFileSync(pinPath(paths), "{ this is not json");
  assert.deepEqual(readPinFile(paths), { pins: {} });
  assert.equal(resolvePin(paths, { cwd: "/work/x", pid: process.pid }), null);
});

test("releaseStalePin frees a key claimed by a dead process", () => {
  const paths = tempPaths();
  writePins(paths, { "pane:wE:p1B": { name: "dxdb-core", procId: "123456:R" } });
  assert.equal(releaseStalePin(paths, "pane:wE:p1B"), true);
  assert.equal(readPinFile(paths).pins["pane:wE:p1B"], undefined);

  // And the freed key can then be claimed by whoever arrives.
  const resolved = claimPin(paths, { paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(resolved, null, "no pin exists until the operator writes one again");
});

test("listPins reports validity and claimed state without mutating", () => {
  const paths = tempPaths();
  writePins(paths, {
    "pane:wE:p1B": { name: "claimed-one", procId: "1:R" },
    "cwd:/work/x": { name: "loose-one" },
    "cwd:/work/y": { name: "BAD NAME" },
  });
  const pins = listPins(paths);
  const byKey = Object.fromEntries(pins.map((p) => [p.key, p]));
  assert.equal(byKey["pane:wE:p1B"].claimed, true);
  assert.equal(byKey["cwd:/work/x"].claimed, false);
  assert.equal(byKey["cwd:/work/y"].valid, false);
});

test("a cwd pin is ignored when another agent shares the directory", () => {
  const paths = tempPaths();
  writePins(paths, { "cwd:/work/x": { name: "dxdb-lead" } });

  // A second live agent in the same cwd, registered under a different name.
  // A different live process in the same directory. pid 1 is always alive and
  // is not us, which is the situation the guard is for.
  registerAgent(paths, "other-lane", 1, "/work/x");

  const resolved = resolvePin(paths, { cwd: "/work/x", pid: process.pid });
  assert.equal(resolved?.name, "", "ambiguous cwd pin must not be applied");
  assert.match(resolved!.rejected!.reason, /another agent shares this directory/);
});

test("a cwd pin applies when the directory holds exactly one lane", () => {
  const paths = tempPaths();
  writePins(paths, { "cwd:/work/solo": { name: "solo-lead" } });
  registerAgent(paths, "lonely", process.pid, "/work/solo");
  const resolved = claimPin(paths, { cwd: "/work/solo", pid: process.pid });
  assert.equal(resolved?.name, "solo-lead");
  assert.equal(resolved?.key, "cwd:/work/solo");
});

test("a session or pane pin is unaffected by cwd ambiguity", () => {
  const paths = tempPaths();
  writePins(paths, {
    "pane:wE:p1B": { name: "by-pane" },
    "cwd:/work/x": { name: "ambiguous" },
  });
  // A different live process in the same directory. pid 1 is always alive and
  // is not us, which is the situation the guard is for.
  registerAgent(paths, "other-lane", 1, "/work/x");
  const resolved = claimPin(paths, { paneId: "wE:p1B", cwd: "/work/x", pid: process.pid });
  assert.equal(resolved?.name, "by-pane");
  assert.equal(resolved?.key, "pane:wE:p1B");
});
