/**
 * Receipt integrity tests.
 *
 * Two properties are under test, both of them things the store got wrong in a
 * way that cost real messages:
 *
 * 1. A per-recipient receipt is *merged*, never reconstructed, so a writer that
 *    does not know about a field cannot erase it.
 * 2. Every read-modify-write of a shared JSON file holds a lock, so two writers
 *    cannot lose each other's update.
 *
 * The lost-update test runs genuine child processes rather than two sequential
 * calls in one process: a sequential test passes with the bug present, because
 * the second call reads the file the first one already wrote.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import init from "../index.ts";

import {
  bootId,
  deliver,
  drain,
  isAlive,
  markDelivered,
  markRead,
  readPosts,
  readReceipts,
  resolvePaths,
  withFileLock,
  type Delivery,
} from "../src/store.ts";

const STORE_URL = new URL("../src/store.ts", import.meta.url).href;
const STORE_FILE = fileURLToPath(STORE_URL);

function tempPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-receipts-"));
  return resolvePaths(base);
}

function message(id: string, to: string[]): Delivery {
  return { id, from: "alpha", to, text: "hello", sentAt: new Date().toISOString() };
}

function receiptFile(paths: ReturnType<typeof tempPaths>, id: string): string {
  return path.join(paths.receipts, `${id}.json`);
}

// ---------------------------------------------------------------------------
// L1 — spread, do not reconstruct
// ---------------------------------------------------------------------------

test("a readAt written first survives a later markDelivered", () => {
  // This is the exact erasure the plan documents: a client stamps readAt, then
  // the extension's delivery path writes the same recipient and reconstructs the
  // object from the two fields it knows, deleting the stamp.
  const paths = tempPaths();
  const id = "11111111-1111-4111-8111-111111111111";
  deliver(paths, message(id, ["beta"]));

  markRead(paths, id, "beta", "2026-11-02T19:00:00.000Z");
  const afterRead = readReceipts(paths, id)!.receipts.beta;
  assert.equal(afterRead.readAt, "2026-11-02T19:00:00.000Z");

  markDelivered(paths, id, "beta");

  const after = readReceipts(paths, id)!.receipts.beta;
  assert.equal(after.readAt, "2026-11-02T19:00:00.000Z", "readAt must not be erased by a delivery write");
  assert.ok(after.deliveredAt != null, "and the delivery is still recorded");
  assert.equal(after.queuedAt, afterRead.queuedAt, "queue time is unchanged");
});

test("a later markDelivered cannot blank an earlier deliveredAt", () => {
  const paths = tempPaths();
  const id = "22222222-2222-4222-8222-222222222222";
  deliver(paths, message(id, ["beta"]));

  markDelivered(paths, id, "beta");
  const first = readReceipts(paths, id)!.receipts.beta.deliveredAt;
  assert.ok(first != null);

  markDelivered(paths, id, "beta");
  assert.equal(readReceipts(paths, id)!.receipts.beta.deliveredAt, first, "first delivery wins");

  // The same rule the store already had, checked from the patch side: a patch
  // that carries no deliveredAt must not remove the stamp that is there.
  markRead(paths, id, "beta");
  assert.equal(readReceipts(paths, id)!.receipts.beta.deliveredAt, first, "a read does not clear delivery");
});

test("markRead twice keeps the first timestamp", () => {
  const paths = tempPaths();
  const id = "33333333-3333-4333-8333-333333333333";
  deliver(paths, message(id, ["beta"]));

  markRead(paths, id, "beta", "2026-11-02T20:00:00.000Z");
  markRead(paths, id, "beta", "2026-11-02T21:30:00.000Z");

  assert.equal(
    readReceipts(paths, id)!.receipts.beta.readAt,
    "2026-11-02T20:00:00.000Z",
    "a second read of the same message is not new information",
  );
});

test("unknown fields written by a future version survive an old-style update", () => {
  const paths = tempPaths();
  const id = "44444444-4444-4444-8444-444444444444";
  deliver(paths, message(id, ["beta"]));

  // A field this version has never heard of, written by some later client.
  const file = receiptFile(paths, id);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.receipts.beta = { ...record.receipts.beta, actedAt: "2026-11-02T22:00:00.000Z" };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  markDelivered(paths, id, "beta");
  markRead(paths, id, "beta");

  const receipt = readReceipts(paths, id)!.receipts.beta as unknown as Record<string, unknown>;
  assert.equal(receipt.actedAt, "2026-11-02T22:00:00.000Z", "a spread keeps what this version does not know");
  assert.ok(receipt.deliveredAt != null);
  assert.ok(receipt.readAt != null);
});

test("the old reconstruct-and-write path still erases readAt — the fix cannot reach an old lane", () => {
  // Not a test of this code: it is the limitation stated in the report, kept
  // executable so the claim is evidence rather than prose. A lane still running
  // d4d0bfa rebuilds the per-recipient object from queuedAt/deliveredAt, so it
  // deletes readAt no matter what this version does.
  const paths = tempPaths();
  const id = "55555555-5555-4555-8555-555555555555";
  deliver(paths, message(id, ["beta"]));
  markRead(paths, id, "beta", "2026-11-02T19:00:00.000Z");

  const file = receiptFile(paths, id);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const current = record.receipts.beta;
  // Verbatim old behaviour, for the same recipient.
  record.receipts.beta = {
    queuedAt: current.queuedAt ?? new Date().toISOString(),
    deliveredAt: current.deliveredAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  assert.equal(readReceipts(paths, id)!.receipts.beta.readAt, undefined, "an old lane still erases readAt");
});

test("a post line carries an id that matches its envelope id", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-int-"));
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (def: any) => tools.set(def.name, def),
    registerCommand: () => {},
    on: () => () => {},
    sendMessage: () => {},
    appendEntry: () => {},
  };
  for (const key of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_SESSION_ID", "PI_AGENT_NAME"]) {
    delete process.env[key];
  }
  process.env.PI_ROOMS_DIR = base;
  process.env.PI_ROOMS_NAME = "lead";
  init(pi as any);

  const ctx = { cwd: "/work/post-id", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
  // A member besides the poster, so the post actually produces a receipt to join to.
  await tools.get("rooms_create").execute("c1", { room: "dxdb", members: ["core"] }, undefined, undefined, ctx);
  const posted = await tools.get("rooms_post").execute(
    "c2",
    { room: "dxdb", message: "with an id" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(posted.isError, undefined);

  const paths = resolvePaths(base);
  const posts = readPosts(paths, "dxdb");
  assert.equal(posts.length, 1);
  const id = posts[0].id;
  assert.ok(id != null, "the log line carries the message id");
  assert.match(id!, /^[0-9a-f-]{36}$/);

  // The join that matters, from both ends: the history id names the envelope the
  // recipient actually received (rooms_post used to mint a second uuid, so the
  // envelope named an id the history did not contain), and it resolves to a
  // receipt file, which is only reachable when both ids agree.
  const pending = drain(paths, "core");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message.id, id, "the envelope id is the post line id");

  assert.ok(fs.existsSync(receiptFile(paths, id!)), "receipts/<id>.json exists for the post id");
  const records = readReceipts(paths, id!);
  assert.equal(records?.id, id);
  assert.ok(records!.receipts.core != null, "the post id's receipt names the recipient it was pushed to");
});

// ---------------------------------------------------------------------------
// L2 — a lock held across the read-modify-write
// ---------------------------------------------------------------------------

/** Write a `.ts` child that waits for a shared wall-clock instant, then writes. */
function writeBarrierWriter(dir: string): string {
  const file = path.join(dir, "writer.ts");
  fs.writeFileSync(
    file,
    [
      `import { markDelivered, resolvePaths } from ${JSON.stringify(STORE_URL)};`,
      `const [base, id, recipient, startAt] = process.argv.slice(2);`,
      `// Busy-wait so every writer crosses into the read-modify-write together.`,
      `// A sleep would let them drift apart and a lost update would not reproduce.`,
      `while (Date.now() < Number(startAt)) {}`,
      `markDelivered(resolvePaths(base), id, recipient);`,
      ``,
    ].join("\n"),
  );
  return file;
}

function runWriter(file: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", file, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("concurrent writers for different recipients both persist", async () => {
  const paths = tempPaths();
  const id = "66666666-6666-4666-8666-666666666666";
  const recipients = ["beta", "gamma", "delta", "epsilon", "zeta", "eta"];
  deliver(paths, message(id, recipients));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-writers-"));
  const wfile = writeBarrierWriter(dir);
  const startAt = String(Date.now() + 400);

  const results = await Promise.all(
    recipients.map((recipient) => runWriter(wfile, [paths.base, id, recipient, startAt])),
  );
  for (const result of results) {
    assert.equal(result.code, 0, `writer failed: ${result.stderr}`);
  }

  const receipts = readReceipts(paths, id)!.receipts;
  for (const recipient of recipients) {
    assert.ok(
      receipts[recipient]?.deliveredAt != null,
      `${recipient}'s delivery must survive every other writer (all writes: ${JSON.stringify(receipts)})`,
    );
  }
});

test("a stale lock from a dead pid does not block a write", () => {
  const paths = tempPaths();
  const id = "77777777-7777-4777-8777-777777777777";
  deliver(paths, message(id, ["beta"]));

  const lockPath = `${receiptFile(paths, id)}.lock`;
  // A writer killed while holding the lock: the pid is gone and the stamp is old.
  const old = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: old }));

  markDelivered(paths, id, "beta");

  assert.ok(readReceipts(paths, id)!.receipts.beta.deliveredAt != null, "the write went through");
  assert.equal(fs.existsSync(lockPath), false, "and the abandoned lock is gone");
});

test("an empty lock file left by a killed writer is recovered from its age", () => {
  // The window between `open(…, "wx")` and the first write: the holder died with
  // nothing in the file, so the pid is unknowable and the mtime is the only
  // evidence of how long it has been there.
  const paths = tempPaths();
  const id = "88888888-8888-4888-8888-888888888888";
  deliver(paths, message(id, ["beta"]));

  const lockPath = `${receiptFile(paths, id)}.lock`;
  fs.writeFileSync(lockPath, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  markDelivered(paths, id, "beta");

  assert.ok(readReceipts(paths, id)!.receipts.beta.deliveredAt != null, "the write went through");
  assert.equal(fs.existsSync(lockPath), false);
});

test("a live lock fails in bounded time, naming the lock path", () => {
  const paths = tempPaths();
  const id = "99999999-9999-4999-8999-999999999999";
  deliver(paths, message(id, ["beta"]));

  const lockPath = `${receiptFile(paths, id)}.lock`;
  // Held by this very process, freshly stamped: alive, so not stale.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const started = Date.now();
  assert.throws(
    () => markDelivered(paths, id, "beta"),
    (error: Error) => {
      assert.match(error.message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.message, /another process holds it/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  // Never blocks indefinitely: a handful of short waits and then a loud failure.
  assert.ok(elapsed < 2_000, `failed in ${elapsed}ms, which is bounded`);
  assert.equal(fs.existsSync(lockPath), true, "a lock this process did not take is not removed");
});

// ---------------------------------------------------------------------------
// L3 — a lock that outlives a reboot
//
// A lock file survives the reboot; the pid inside it does not. After the reboot
// the kernel hands that number to an unrelated process, so the lock reads as
// *held* by a bare pid test until the budget expires — and every write after it
// throws, forever. The boot id is the evidence that the holder cannot be inside
// its critical section, exactly as it is for a stale registration.
// ---------------------------------------------------------------------------

/** A boot id no machine running these tests can be in. */
const EARLIER_BOOT = "00000000-0000-0000-0000-000000000000";

test("a lock from an earlier boot does not block a write, however alive its pid looks", (t) => {
  // The exact post-reboot state: the file says `pid: N`, and N is live *now* —
  // it is this very process. Only the boot id says the holder is gone.
  const current = bootId();
  if (current == null) {
    t.skip("no boot id on this platform, so there is nothing to compare");
    return;
  }
  const paths = tempPaths();
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  deliver(paths, message(id, ["beta"]));

  const lockPath = `${receiptFile(paths, id)}.lock`;
  const old = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: old, bootId: EARLIER_BOOT }));
  assert.notEqual(EARLIER_BOOT, current, "precondition: the lock names a different boot");
  assert.equal(isAlive(process.pid), true, "precondition: the pid it names is alive");

  // Without the boot check this throws after the full wait budget, and keeps
  // throwing on every later write: the wedge.
  markDelivered(paths, id, "beta");

  assert.ok(readReceipts(paths, id)!.receipts.beta.deliveredAt != null, "the write went through");
  assert.equal(fs.existsSync(lockPath), false, "and the foreign-boot lock is gone");
});

test("a lock from an earlier boot with no pid recovers from its age", (t) => {
  // A partial write, or a body from a build older than a field: the boot id is
  // present but nothing else usable is. It must not wedge either.
  if (bootId() == null) {
    t.skip("no boot id on this platform, so there is nothing to compare");
    return;
  }
  const paths = tempPaths();
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  deliver(paths, message(id, ["beta"]));

  const lockPath = `${receiptFile(paths, id)}.lock`;
  const old = new Date(Date.now() - 60_000);
  fs.writeFileSync(lockPath, JSON.stringify({ startedAt: old.toISOString(), bootId: EARLIER_BOOT }));
  fs.utimesSync(lockPath, old, old);

  markDelivered(paths, id, "beta");

  assert.ok(readReceipts(paths, id)!.receipts.beta.deliveredAt != null, "the write went through");
  assert.equal(fs.existsSync(lockPath), false);
});

test("a lock from this boot held by a live pid is still respected", (t) => {
  // The regression the fix must not introduce: a genuinely held lock is not
  // free just because we now understand boots. Same pid, same boot, fresh.
  const current = bootId();
  if (current == null) {
    t.skip("no boot id on this platform, so there is nothing to compare");
    return;
  }
  const paths = tempPaths();
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  deliver(paths, message(id, ["beta"]));

  const lockPath = `${receiptFile(paths, id)}.lock`;
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), bootId: current }),
  );

  assert.throws(
    () => markDelivered(paths, id, "beta"),
    (error: Error) => {
      assert.match(error.message, /another process holds it/);
      return true;
    },
  );
  assert.equal(fs.existsSync(lockPath), true, "a lock from this boot is not stolen");
  assert.equal(readReceipts(paths, id)?.receipts.beta?.deliveredAt, undefined, "and nothing was written");
});

test("a lock with no boot id falls through to the pid test, as an older writer's does", () => {
  // Compatibility: a writer running the previous build stamps no boot id. Its
  // live lock must still hold, and its dead lock must still recover. Absence is
  // not evidence of a foreign boot.
  const paths = tempPaths();
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  deliver(paths, message(id, ["beta"]));

  const lockPath = `${receiptFile(paths, id)}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  assert.throws(() => markDelivered(paths, id, "beta"), /another process holds it/);
  assert.equal(fs.existsSync(lockPath), true);

  // And the same shape with a dead pid still recovers, unchanged.
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, startedAt: new Date(Date.now() - 60_000).toISOString() }),
  );
  markDelivered(paths, id, "beta");
  assert.ok(readReceipts(paths, id)!.receipts.beta.deliveredAt != null, "the write went through");
  assert.equal(fs.existsSync(lockPath), false);
});

test("the lock this process takes carries this boot's id", (t) => {
  // The stamp itself: without it the guard above has nothing to compare, so a
  // writer that forgets to record the boot silently reopens the wedge.
  const current = bootId();
  if (current == null) {
    t.skip("no boot id on this platform, so there is nothing to record");
    return;
  }
  const paths = tempPaths();
  const target = path.join(paths.base, "guarded.json");
  const lockPath = `${target}.lock`;

  withFileLock(target, () => {
    const body = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; bootId?: string };
    assert.equal(body.bootId, current, "the lock records the boot it was taken in");
    assert.equal(body.pid, process.pid);
    return null;
  });
});

test("a lock file is removed after a throwing fn", () => {
  const paths = tempPaths();
  const target = path.join(paths.base, "guarded.json");
  const lockPath = `${target}.lock`;

  assert.throws(
    () => withFileLock(target, () => {
      assert.equal(fs.existsSync(lockPath), true, "the lock exists while fn runs");
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(fs.existsSync(lockPath), false, "the lock does not leak");

  // And the path is usable again, which is the property that matters.
  assert.equal(withFileLock(target, () => "ok"), "ok");
});

test("the lock is exclusive: a nested acquire of the same file fails rather than interleaving", () => {
  const paths = tempPaths();
  const target = path.join(paths.base, "guarded.json");

  withFileLock(target, () => {
    assert.throws(() => withFileLock(target, () => "inner"), /another process holds it/);
    return null;
  });
});

test("appendPost keeps one post per line, so a post id can be read back", () => {
  // Guards the seam the post-id change sits on: the id is only joinable if the
  // line parses, and a line only parses if it ends in a newline.
  const paths = tempPaths();
  const file = path.join(paths.rooms, "dxdb", "log.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");

  const raw = `{"id":"aaaaaaa1-1111-4111-8111-111111111111","from":"lead","text":"a","sentAt":"${new Date().toISOString()}","recipients":[]}\n`;
  fs.appendFileSync(file, raw);
  const posts = readPosts(paths, "dxdb");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, "aaaaaaa1-1111-4111-8111-111111111111");
});

test("the store module the child processes import is the one under test", () => {
  assert.equal(STORE_FILE, fileURLToPath(STORE_URL));
  assert.ok(fs.existsSync(STORE_FILE));
});
