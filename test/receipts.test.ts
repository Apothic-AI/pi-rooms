/**
 * Receipt integrity.
 *
 * A message has one receipt per recipient. Several recipients can archive the
 * same message at almost the same instant — that is the normal case in a fleet
 * where four lanes are handed a post together — so the receipt store must not
 * lose one writer's observation when another writes.
 *
 * The first test is a real cross-process race: child processes stand in for
 * four live lanes archiving their own inbox exactly as `flush()` does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { deliver, readReceipts, resolvePaths } from "../src/store.ts";

const STORE_URL = new URL("../src/store.ts", import.meta.url).href;

/** A stand-in lane: polls its inbox and archives whatever it finds. */
const ARCHIVER = `
import * as fs from "node:fs";
import * as path from "node:path";
const store = await import(process.env.ARCH_STORE);
const base = process.env.ARCH_BASE;
const name = process.env.ARCH_NAME;
const delay = Number(process.env.ARCH_DELAY ?? 0);
const paths = store.resolvePaths(base);
const dir = path.join(base, "inbox", name);
fs.mkdirSync(dir, { recursive: true });
const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* keep timing tight */ } };
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(dir, file);
    let message;
    try { message = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
    if (delay > 0) spin(delay);
    store.archive(paths, name, full, message);
  }
}
`;

function scratchBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-receipts-"));
}

function startArchiver(base: string, name: string, delayMs: number) {
  return spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", ARCHIVER], {
    stdio: "ignore",
    env: {
      ...process.env,
      ARCH_STORE: STORE_URL,
      ARCH_BASE: base,
      ARCH_NAME: name,
      ARCH_DELAY: String(delayMs),
    },
  });
}

test("concurrent recipients archiving one message lose no deliveredAt", async () => {
  const base = scratchBase();
  const paths = resolvePaths(base);
  // Eight recipients, eight live archivers. The shared-receipt defect is a
  // read-modify-write race, so it needs real write pressure to show itself;
  // with this crowd it is not a rare coincidence, it is the steady state.
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  for (const name of names) fs.mkdirSync(path.join(base, "inbox", name), { recursive: true });

  const children = names.map((name) => startArchiver(base, name, 1));
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 100 messages keeps each lane's read/ archive under READ_HISTORY_LIMIT (200
  // files, two per message), so nothing is pruned out from under the count.
  const messages = 100;
  const ids: string[] = [];
  for (let i = 0; i < messages; i += 1) {
    const id = randomUUID();
    ids.push(id);
    deliver(paths, {
      id,
      from: "sender",
      to: [...names],
      text: `race ${i}`,
      sentAt: new Date().toISOString(),
    });
    // Small waves, so each archiver is mid-drain while the next burst lands.
    if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 15));
  }

  // Wait for the archivers to finish rather than sampling a half-drained queue.
  const deadline = Date.now() + 30_000;
  let remaining = Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    remaining = names.reduce(
      (sum, name) => sum + fs.readdirSync(path.join(base, "inbox", name)).filter((f) => f.endsWith(".json")).length,
      0,
    );
    if (remaining === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const child of children) child.kill();

  let archived = 0;
  const lost: string[] = [];
  for (const id of ids) {
    for (const name of names) {
      if (!fs.existsSync(path.join(base, "inbox", name, "read", `${id}.json`))) continue;
      archived += 1;
      if (readReceipts(paths, id)?.receipts[name]?.deliveredAt == null) lost.push(`${id.slice(0, 8)}:${name}`);
    }
  }
  assert.equal(remaining, 0, "every copy should have been archived");
  assert.equal(archived, messages * names.length, "every delivered copy is archived");
  assert.deepEqual(lost, [], `every archived copy keeps its deliveredAt (lost ${lost.length} of ${archived})`);
});

test("a legacy single-file receipt is still read, merged with the per-recipient files", () => {
  const base = scratchBase();
  const paths = resolvePaths(base);
  const id = randomUUID();
  // Written by an older build, before receipts were split per recipient.
  fs.mkdirSync(paths.receipts, { recursive: true });
  fs.writeFileSync(
    path.join(paths.receipts, `${id}.json`),
    `${JSON.stringify(
      {
        id,
        receipts: {
          legacy: { queuedAt: "2026-11-01T00:00:00.000Z", deliveredAt: "2026-11-01T00:00:01.000Z" },
        },
      },
      null,
      2,
    )}\n`,
  );

  deliver(paths, { id, from: "sender", to: ["fresh"], text: "x", sentAt: new Date().toISOString() });

  const receipts = readReceipts(paths, id);
  assert.ok(receipts != null);
  assert.deepEqual(Object.keys(receipts.receipts).sort(), ["fresh", "legacy"]);
  assert.equal(receipts.receipts.legacy.deliveredAt, "2026-11-01T00:00:01.000Z", "legacy read is not rewritten");
  assert.ok(receipts.receipts.fresh.queuedAt.length > 0);
  assert.equal(receipts.receipts.fresh.deliveredAt, undefined);
});

test("one recipient's receipt is untouched by another recipient's mark", async () => {
  const base = scratchBase();
  const paths = resolvePaths(base);
  const { drain, archive } = await import("../src/store.ts");
  const id = randomUUID();
  deliver(paths, { id, from: "sender", to: ["alpha", "beta"], text: "x", sentAt: new Date().toISOString() });
  const queuedAt = readReceipts(paths, id)!.receipts.alpha.queuedAt;

  const pending = drain(paths, "alpha");
  archive(paths, "alpha", pending[0].file, pending[0].message);

  const receipts = readReceipts(paths, id)!;
  assert.ok(receipts.receipts.alpha.deliveredAt != null, "alpha is delivered");
  assert.equal(receipts.receipts.alpha.queuedAt, queuedAt, "queue time is not rewritten");
  assert.equal(receipts.receipts.beta.deliveredAt, undefined, "beta is untouched");
});

test("a rollback can fold per-recipient receipts back into the legacy single file", async () => {
  const base = scratchBase();
  const paths = resolvePaths(base);
  const { archive, consolidateReceipts, drain } = await import("../src/store.ts");
  const id = randomUUID();
  deliver(paths, { id, from: "sender", to: ["alpha", "beta"], text: "x", sentAt: new Date().toISOString() });

  // Both recipients get handed the message, each writing only its own file.
  for (const name of ["alpha", "beta"]) {
    const pending = drain(paths, name);
    archive(paths, name, pending[0].file, pending[0].message, { injectedAt: new Date().toISOString() });
  }
  // A build without per-recipient receipt support cannot see those files at all.
  assert.equal(fs.existsSync(path.join(paths.receipts, `${id}.json`)), false);

  const folded = consolidateReceipts(paths);
  assert.deepEqual(folded, { messages: 1, recipients: 2 });

  // Read exactly as the older build does: one file, one record per recipient.
  const legacy = JSON.parse(fs.readFileSync(path.join(paths.receipts, `${id}.json`), "utf8")) as {
    id: string;
    receipts: Record<string, { queuedAt: string; deliveredAt?: string; injectedAt?: string }>;
  };
  assert.equal(legacy.id, id);
  assert.deepEqual(Object.keys(legacy.receipts).sort(), ["alpha", "beta"]);
  for (const name of ["alpha", "beta"]) {
    assert.ok(legacy.receipts[name].queuedAt.length > 0, `${name} keeps its queue time`);
    assert.ok(legacy.receipts[name].deliveredAt != null, `${name} reads as delivered after rollback`);
    assert.ok(legacy.receipts[name].injectedAt != null, `${name} keeps its handoff stamp`);
  }

  // Idempotent, and it still merges into a legacy record that already exists.
  const again = consolidateReceipts(paths);
  assert.deepEqual(again, { messages: 1, recipients: 0 });
  const reread = JSON.parse(fs.readFileSync(path.join(paths.receipts, `${id}.json`), "utf8")) as typeof legacy;
  assert.deepEqual(reread.receipts, legacy.receipts);

  // The merged record is also what the current reader returns, legacy included.
  assert.ok(readReceipts(paths, id)!.receipts.alpha.deliveredAt != null);
});

test("a receipt lock that cannot be taken fails closed instead of writing unprotected", async () => {
  const base = scratchBase();
  const paths = resolvePaths(base);
  const { markDelivered } = await import("../src/store.ts");
  const id = randomUUID();
  deliver(paths, { id, from: "sender", to: ["alpha"], text: "x", sentAt: new Date().toISOString() });
  const file = path.join(paths.receipts, id, "alpha.json");
  const before = fs.readFileSync(file, "utf8");

  // A fresh lock, as a holder stalled mid-write would leave behind.
  const lock = `${file}.lock`;
  fs.mkdirSync(lock);

  assert.throws(
    () => markDelivered(paths, id, "alpha", new Date().toISOString()),
    /could not lock .*refusing to write the receipt unprotected/,
    "an unavailable lock must throw rather than degrade to an unlocked write",
  );
  assert.equal(fs.readFileSync(file, "utf8"), before, "the receipt was not touched");
  assert.equal(fs.existsSync(lock), true, "and the foreign lock was not stolen");

  // The same lock, aged past the staleness bound, is reclaimed and the write lands.
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lock, old, old);
  markDelivered(paths, id, "alpha", new Date().toISOString());
  const after = JSON.parse(fs.readFileSync(file, "utf8")) as { deliveredAt?: string; injectedAt?: string };
  assert.ok(after.deliveredAt != null, "the stale lock is reclaimed and the receipt is written");
  assert.ok(after.injectedAt != null);
  assert.equal(fs.existsSync(lock), false, "and released afterwards");
});

test("the rollback is runnable through the rooms_receipts tool", async () => {
  const { default: init } = await import("../index.ts");
  const base = scratchBase();
  const paths = resolvePaths(base);
  const id = randomUUID();
  deliver(paths, { id, from: "sender", to: ["alpha", "beta"], text: "x", sentAt: new Date().toISOString() });
  for (const name of ["alpha", "beta"]) {
    const pending = (await import("../src/store.ts")).drain(paths, name);
    (await import("../src/store.ts")).archive(paths, name, pending[0].file, pending[0].message);
  }
  assert.equal(fs.existsSync(path.join(paths.receipts, `${id}.json`)), false, "nothing legacy yet");

  const tools = new Map<string, any>();
  for (const key of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_SESSION_ID", "PI_AGENT_NAME", "PI_ROOMS_NAME"]) {
    delete process.env[key];
  }
  process.env.PI_ROOMS_DIR = base;
  process.env.PI_ROOMS_NAME = "ops-lane";
  init({
    registerTool: (def: any) => tools.set(def.name, def),
    registerCommand: () => {},
    on: () => () => {},
    sendMessage: () => {},
    appendEntry: () => {},
  } as any);

  const tool = tools.get("rooms_receipts");
  assert.ok(tool != null, "rooms_receipts is registered");
  const result = await tool.execute("t", { action: "consolidate" }, undefined, undefined, {
    cwd: "/scratch/ops",
    hasUI: false,
    ui: { setStatus: () => {}, notify: () => {} },
  });
  assert.equal(result.details.messages, 1);
  assert.equal(result.details.recipients, 2);
  assert.match(result.content[0].text, /Consolidated 1 message\(s\), 2 new recipient receipt\(s\)/);

  // Exactly what an older build's reader does.
  const legacy = JSON.parse(fs.readFileSync(path.join(paths.receipts, `${id}.json`), "utf8")) as {
    receipts: Record<string, { deliveredAt?: string }>;
  };
  assert.ok(legacy.receipts.alpha.deliveredAt != null);
  assert.ok(legacy.receipts.beta.deliveredAt != null);
});
