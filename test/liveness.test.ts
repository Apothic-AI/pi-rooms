/**
 * Liveness and receipt tests.
 *
 * The interesting cases are the ones that made the roster lie during a reboot:
 * a pid that is alive but is no longer the process that registered, and an
 * entry from an earlier boot. Both are reproduced here rather than described.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  bootId,
  isAlive,
  isRegistrationLive,
  livenessDiagnosis,
  listAgents,
  procIdentity,
  readReceipts,
  readRoster,
  register,
  resolvePaths,
  deliver,
  drain,
  archive,
  type Delivery,
  type Registration,
} from "../src/store.ts";

function tempPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-live-"));
  return resolvePaths(base);
}

function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    name: "alpha",
    pid: process.pid,
    cwd: "/work/x",
    bootId: bootId() ?? undefined,
    procId: procIdentity(process.pid) ?? undefined,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("this process reports live with its own identity", () => {
  assert.equal(isRegistrationLive(reg()), true);
  assert.equal(livenessDiagnosis(reg()), null);
});

test("a pid nobody holds is dead", () => {
  assert.equal(isRegistrationLive(reg({ pid: 999999 })), false);
  assert.equal(livenessDiagnosis(reg({ pid: 999999 })), "no such process");
});

test("a pid reused by another process is dead, even though the pid is alive", () => {
  // pid 1 is always alive, but it is not the process that registered.
  assert.equal(isAlive(1), true, "precondition: pid 1 exists");
  const stale = reg({ pid: 1, procId: "0:S" });
  assert.equal(isRegistrationLive(stale), false, "starttime mismatch must be fatal");
  assert.equal(livenessDiagnosis(stale), "pid was reused by another process");
});

test("an entry from an earlier boot is dead regardless of its pid", () => {
  const stale = reg({ bootId: "an-earlier-boot", procId: procIdentity(process.pid) ?? undefined });
  assert.equal(isRegistrationLive(stale), false);
  assert.equal(livenessDiagnosis(stale), "registered in an earlier boot");
});

test("a zombie is dead even though kill(pid, 0) would succeed", async () => {
  // A real zombie has to be manufactured by a parent that does not reap it.
  // Node reaps its own children, so this uses a python parent that forks, lets
  // the child exit, prints its pid, then sleeps without calling wait(). The
  // parent must still be alive when we look, so it is read while sleeping
  // rather than waited for.
  const { spawn } = await import("node:child_process");
  const script = [
    "import os,time,sys",
    "pid=os.fork()",
    "if pid==0: os._exit(0)",
    "print(pid,flush=True)",
    "time.sleep(5)",
  ].join("\n");
  const parent = spawn("python3", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const zombiePid = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error(`no pid printed; got ${JSON.stringify(buffer)}`)), 5000);
      parent.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const line = buffer.split("\n")[0];
        if (line != null && line.trim().length > 0) {
          clearTimeout(timer);
          resolve(Number(line.trim()));
        }
      });
    });

    // Give the child a moment to exit and settle into Z while its parent holds it.
    let identity: string | null = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      identity = procIdentity(zombiePid);
      if (identity != null && identity.split(":")[1] === "Z") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(identity != null, "zombie should still have a /proc entry");
    assert.equal(identity!.split(":")[1], "Z", "child should be a zombie");
    assert.equal(isAlive(zombiePid), true, "precondition: a zombie answers kill(pid, 0)");

    const zombie = reg({ pid: zombiePid, procId: identity! });
    assert.equal(isRegistrationLive(zombie), false);
    assert.equal(livenessDiagnosis(zombie), "process is a zombie");
  } finally {
    parent.kill("SIGKILL");
  }
});

test("no proc identity recorded still falls back to the pid check", () => {
  // This is the non-Linux path: it must not report everything dead.
  assert.equal(isRegistrationLive(reg({ procId: undefined, bootId: undefined })), true);
  assert.equal(isRegistrationLive(reg({ procId: undefined, pid: 999999 })), false);
});

test("a reused pid is reaped from the roster rather than listed", () => {
  const paths = tempPaths();
  register(paths, reg({ name: "ghost", pid: 1, procId: "0:S" }));
  assert.deepEqual(listAgents(paths).map((a) => a.name), []);
  assert.equal(fs.existsSync(path.join(paths.registry, "ghost.json")), false);
});

test("readRoster reports the gone reason instead of hiding the entry", () => {
  const paths = tempPaths();
  register(paths, reg({ name: "live" }));
  register(paths, reg({ name: "gone", pid: 999999 }));
  const roster = readRoster(paths);
  assert.equal(roster.length, 2);
  const byName = Object.fromEntries(roster.map((r) => [r.name, r.gone]));
  assert.equal(byName.live, null);
  assert.equal(byName.gone, "no such process");
  // readRoster must not prune; that is listAgents' job.
  assert.equal(fs.existsSync(path.join(paths.registry, "gone.json")), true);
});

test("proc identity is stable across two reads of the same process", () => {
  const a = procIdentity(process.pid);
  const b = procIdentity(process.pid);
  assert.equal(a, b);
  assert.match(a!, /^\d+:[A-Za-z]$/);
});

test("proc identity is null for a pid that does not exist", () => {
  assert.equal(procIdentity(999999), null);
});

test("a direct message records queued for each recipient, then delivered on archive", () => {
  const paths = tempPaths();
  const message: Delivery = {
    id: "bbbbbbbb-1111-2222-3333-444444444444",
    from: "alpha",
    to: ["beta", "gamma"],
    text: "hello",
    sentAt: new Date().toISOString(),
  };
  deliver(paths, message);

  const queued = readReceipts(paths, message.id);
  assert.ok(queued != null);
  assert.deepEqual(Object.keys(queued.receipts).sort(), ["beta", "gamma"]);
  for (const receipt of Object.values(queued.receipts)) {
    assert.ok(receipt.queuedAt.length > 0);
    assert.equal(receipt.deliveredAt, undefined, "queued is not delivered");
  }

  const pending = drain(paths, "beta");
  assert.equal(pending.length, 1);
  assert.ok(pending[0].message.queuedAt != null, "the inbox copy carries its queue time");
  archive(paths, "beta", pending[0].file, pending[0].message);

  const after = readReceipts(paths, message.id);
  assert.ok(after!.receipts.beta.deliveredAt != null, "archive records delivery");
  assert.equal(after!.receipts.gamma.deliveredAt, undefined, "gamma is untouched");
  assert.equal(after!.receipts.beta.queuedAt, queued!.receipts.beta.queuedAt, "queue time is not rewritten");
});

test("a receipt timestamp never moves backwards on a repeated call", () => {
  const paths = tempPaths();
  const message: Delivery = {
    id: "cccccccc-1111-2222-3333-444444444444",
    from: "alpha",
    to: ["beta"],
    text: "hi",
    sentAt: new Date().toISOString(),
  };
  deliver(paths, message);
  const first = readReceipts(paths, message.id)!.receipts.beta.queuedAt;
  deliver(paths, message);
  assert.equal(readReceipts(paths, message.id)!.receipts.beta.queuedAt, first);
});

test("the archived copy keeps both timestamps so reply_all still resolves it", () => {
  const paths = tempPaths();
  const message: Delivery = {
    id: "dddddddd-1111-2222-3333-444444444444",
    from: "alpha",
    to: ["beta"],
    text: "question",
    sentAt: new Date().toISOString(),
  };
  deliver(paths, message);
  const pending = drain(paths, "beta");
  archive(paths, "beta", pending[0].file, pending[0].message);
  const archived = JSON.parse(
    fs.readFileSync(path.join(paths.inbox, "beta", "read", `${message.id}.json`), "utf8"),
  ) as Delivery;
  assert.ok(archived.queuedAt != null);
  assert.ok(archived.deliveredAt != null);
  assert.deepEqual(archived.to, ["beta"]);
});

test("readReceipts rejects junk ids instead of reading arbitrary paths", () => {
  const paths = tempPaths();
  assert.equal(readReceipts(paths, "../../etc/passwd"), null);
  assert.equal(readReceipts(paths, ""), null);
});
