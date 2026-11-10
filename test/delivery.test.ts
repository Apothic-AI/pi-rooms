/**
 * Delivery: how queued messages reach the session.
 *
 * The stub records the `sendMessage` options, which the older integration stub
 * dropped — delivery mode and wake behaviour are the whole subject here, so they
 * have to be observable.
 *
 * Three properties are asserted:
 *
 * 1. a single fresh message behaves exactly as before (one handoff, its own mode,
 *    one wake);
 * 2. a batch is bounded, ordered and woken once — every message is still handed
 *    over in full, because nothing here may stand in for a body;
 * 3. the watcher follows a rename, the inbox being left behind is drained, and
 *    mail that keeps arriving at the old name is still delivered for a while.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { spawn } from "node:child_process";

import init from "../index.ts";
import {
  bootId,
  defaultName,
  listAgents,
  procIdentity,
  readReceipts,
  register,
  resolvePaths,
  unregister,
} from "../src/store.ts";

interface Sent {
  text: string;
  deliverAs: string | undefined;
  triggerTurn: boolean | undefined;
  digest: boolean;
  at: number;
}

interface Harness {
  sent: Sent[];
  handlers: Map<string, Function>;
  tools: Map<string, any>;
  shutdown: () => Promise<void>;
}

function base(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-delivery-"));
}

function load(
  dir: string,
  env: Record<string, string> = {},
  hooks: { onSend?: (index: number) => void } = {},
): Harness {
  for (const key of [
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
    "PI_SESSION_ID",
    "PI_AGENT_NAME",
    "PI_ROOMS_NAME",
  ]) {
    delete process.env[key];
  }
  process.env.PI_ROOMS_DIR = dir;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const sent: Sent[] = [];
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (def: any) => tools.set(def.name, def),
    registerCommand: () => {},
    on: (event: string, handler: Function) => {
      handlers.set(event, handler);
      return () => {};
    },
    sendMessage: (message: any, options: any) => {
      // Called before the records below are appended, so a hook sees the world as
      // it is *during* the handoff — which is where a takeover has to be caught.
      hooks.onSend?.(sent.length);
      sent.push({
        text: typeof message.content === "string" ? message.content : "",
        deliverAs: options?.deliverAs,
        triggerTurn: options?.triggerTurn,
        digest: message.details?.digest === true,
        at: Date.now(),
      });
    },
    appendEntry: () => {},
  };
  init(pi as any);
  return {
    sent,
    handlers,
    tools,
    shutdown: async () => {
      const handler = handlers.get("session_shutdown");
      if (handler) await handler({ reason: "quit" }, ctx());
    },
  };
}

function ctx(cwd = "/scratch/lane") {
  return { cwd, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } } as any;
}

async function start(harness: Harness, reason = "startup", cwd = "/scratch/lane") {
  await harness.handlers.get("session_start")!({ reason }, ctx(cwd));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write a message file exactly as store.deliver() lays one out. */
function queue(
  dir: string,
  recipient: string,
  options: { from?: string; ageMs?: number; room?: string; roomSeq?: number; text?: string; index?: number } = {},
): string {
  const inbox = path.join(dir, "inbox", recipient);
  fs.mkdirSync(inbox, { recursive: true });
  const stamp = Date.now() - (options.ageMs ?? 0);
  const id = randomUUID();
  const file = path.join(inbox, `${stamp}-${options.index ?? 0}-${id.slice(0, 8)}.json`);
  const message: Record<string, unknown> = {
    id,
    from: options.from ?? "peer",
    to: [recipient],
    text: options.text ?? `message ${id.slice(0, 8)}`,
    sentAt: new Date(stamp).toISOString(),
    queuedAt: new Date(stamp).toISOString(),
  };
  if (options.room != null) {
    message.room = options.room;
    message.roomSeq = options.roomSeq ?? 1;
  }
  fs.writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`);
  return id;
}

function configure(dir: string, config: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
}

test("a single fresh direct message is handed over once, standalone, with its own mode", async () => {
  const dir = base();
  queue(dir, "lane", { text: "hello" });
  const harness = load(dir, { PI_ROOMS_NAME: "lane" });
  await start(harness);
  await sleep(300);
  await harness.shutdown();

  assert.equal(harness.sent.length, 1, "one message, one handoff");
  assert.equal(harness.sent[0].deliverAs, "steer", "direct messages keep their configured mode");
  assert.equal(harness.sent[0].triggerTurn, true, "an idle lane is woken");
  assert.doesNotMatch(harness.sent[0].text, /^\[stale/, "a fresh message is not labelled stale");
  assert.doesNotMatch(harness.sent[0].text, /\[backlog\]/, "a single message is not summarised");
  assert.match(harness.sent[0].text, /hello/);
});

test("a single fresh room post keeps followUp", async () => {
  const dir = base();
  queue(dir, "lane", { room: "ops", roomSeq: 1, text: "ship it" });
  const harness = load(dir, { PI_ROOMS_NAME: "lane" });
  await start(harness);
  await sleep(300);
  await harness.shutdown();

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].deliverAs, "followUp", "room posts keep their configured mode");
  assert.equal(harness.sent[0].triggerTurn, true);
});

test("a batch is bounded, ordered, and woken once", async () => {
  const dir = base();
  // Default maxDeliverPerFlush is 5, so six queued messages need two ticks.
  for (let i = 0; i < 6; i += 1) queue(dir, "lane", { index: i, text: `m${i}` });

  const harness = load(dir, { PI_ROOMS_NAME: "lane" });
  await start(harness);
  // Asserted on the tick itself: archiving creates `read/` inside the watched
  // inbox, which re-triggers the watcher ~50 ms later for the remainder.
  const firstTick = harness.sent.length;
  const firstWakes = harness.sent.filter((entry) => entry.triggerTurn === true).length;
  assert.equal(firstTick, 5, "the first flush stops at maxDeliverPerFlush");
  assert.equal(firstWakes, 1, "only the first handoff of a flush asks for a turn");
  assert.deepEqual(
    harness.sent.map((entry) => entry.text.split("\n\n")[1].trim()),
    ["m0", "m1", "m2", "m3", "m4"],
    "arrival order is preserved",
  );

  await sleep(600); // the remainder follows on the continuation, not the poller
  await harness.shutdown();

  assert.equal(harness.sent.length, 6, "the remainder is delivered, not dropped");
  assert.match(harness.sent[5].text, /m5/);
  assert.equal(harness.sent[5].triggerTurn, true, "the reminder of a new flush may wake again");
});

test("a 30-message backlog arrives in bounded, age-marked batches on the continuation, never summarised", async () => {
  const dir = base();
  // A poll interval far longer than the test: only the continuation can explain
  // a backlog that drains in seconds.
  configure(dir, { pollMs: 60_000 });
  for (let i = 0; i < 30; i += 1) {
    queue(dir, "lane", { index: i, ageMs: 2 * 3600_000, text: `m${i}` });
  }

  const harness = load(dir, { PI_ROOMS_NAME: "lane" });
  const started = Date.now();
  await start(harness);
  for (let i = 0; i < 200 && harness.sent.length < 30; i += 1) await sleep(50);
  const elapsed = Date.now() - started;
  await harness.shutdown();

  assert.equal(harness.sent.length, 30, "every message is handed over in full");
  assert.equal(
    new Set(harness.sent.map((entry) => entry.text.split("\n\n")[1].trim())).size,
    30,
    "each message is handed over exactly once",
  );
  assert.equal(harness.sent.filter((entry) => entry.digest).length, 0, "no digest stands in for content");
  assert.ok(
    harness.sent.every((entry) => entry.text.startsWith("[stale · queued 2h")),
    "every stale message carries its age",
  );
  assert.ok(
    elapsed < 6000,
    `the remainder comes from the continuation, not the ${60_000}ms poller (${elapsed}ms)`,
  );
  const wakes = harness.sent.filter((entry) => entry.triggerTurn === true).length;
  assert.ok(wakes < 10, `one wake per batch, not one per message (${wakes} wakes for 30 messages)`);
  const gaps = harness.sent
    .slice(1)
    .map((entry, index) => entry.at - harness.sent[index].at)
    .filter((gap) => gap > 100);
  assert.ok(
    gaps.every((gap) => gap < 1000),
    `batch boundaries are the continuation delay, not the poll interval (${gaps.join(",")})`,
  );
});

test("a message that waited is labelled with its age, and the handoff records injectedAt", async () => {
  const dir = base();
  const id = queue(dir, "lane", { ageMs: 2 * 3600_000, text: "old news" });
  const harness = load(dir, { PI_ROOMS_NAME: "lane" });
  await start(harness);
  await sleep(300);
  await harness.shutdown();

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /^\[stale · queued 2h \d+m ago\]/, "the age is in the message");

  const receipt = readReceipts(resolvePaths(dir), id)?.receipts.lane;
  assert.ok(receipt?.deliveredAt != null, "deliveredAt is still the handoff stamp");
  assert.ok(receipt?.injectedAt != null, "injectedAt is recorded alongside it");
});

test("a rename rebinds the watcher and drains the inbox being left behind", async () => {
  const dir = base();
  // A long poll interval makes the watcher the only thing that can deliver quickly.
  configure(dir, { pollMs: 60_000 });
  const cwd = "/scratch/rename-lane";
  const harness = load(dir, { PI_SESSION_ID: "sess-rename" });
  // Resolved after load() has cleared the ambient identity env, so this is the
  // name the session actually registers under.
  const original = defaultName(cwd);
  await start(harness, "startup", cwd);
  assert.equal(harness.sent.length, 0, "nothing queued yet");

  // Left behind: written in the same turn as the rename, so the 50 ms watch
  // debounce has not fired and the old inbox still holds it when the name moves.
  queue(dir, original, { text: "left behind" });
  await harness.tools.get("rooms_pins").execute(
    "pin-call",
    { action: "set", key: "session:sess-rename", name: "pinned-lane" },
    undefined,
    undefined,
    ctx(cwd),
  );

  // The new inbox must be watched: with pollMs at 60s only the rebind can explain
  // a handoff this fast.
  queue(dir, "pinned-lane", { text: "to the new name" });
  const t0 = Date.now();
  let renamedLatency = -1;
  for (let i = 0; i < 30; i += 1) {
    const hit = harness.sent.find((entry) => entry.text.includes("to the new name"));
    if (hit) {
      renamedLatency = hit.at - t0;
      break;
    }
    await sleep(50);
  }
  await sleep(200);
  await harness.shutdown();

  assert.ok(renamedLatency >= 0 && renamedLatency < 900, `new inbox is watched (${renamedLatency}ms)`);
  const behind = harness.sent.filter((entry) => entry.text.includes("left behind"));
  assert.equal(behind.length, 1, "the abandoned inbox is drained exactly once");
  assert.equal(behind[0].triggerTurn, true, "the drained message still follows the flush rules");
});

test("nothing is archived as delivered unless its own body was handed over", async () => {
  const dir = base();
  // A mixed backlog, above any batch or summary threshold: 7 direct messages and
  // 7 room posts, all stale, arriving in one burst.
  const expected: { id: string; body: string }[] = [];
  for (let i = 0; i < 7; i += 1) {
    const body = `direct body ${i}`;
    expected.push({ id: queue(dir, "lane", { index: i, ageMs: 3 * 3600_000, text: body }), body });
  }
  for (let i = 0; i < 7; i += 1) {
    const body = `room body ${i}`;
    expected.push({
      id: queue(dir, "lane", { index: 7 + i, ageMs: 3 * 3600_000, room: "ops", roomSeq: i + 1, text: body }),
      body,
    });
  }

  const harness = load(dir, { PI_ROOMS_NAME: "lane" });
  await start(harness);
  for (let i = 0; i < 200 && harness.sent.length < expected.length; i += 1) await sleep(50);
  await harness.shutdown();

  const paths = resolvePaths(dir);
  for (const { id, body } of expected) {
    const handed = harness.sent.filter((entry) => entry.text.includes(body));
    assert.equal(handed.length, 1, `"${body}" is handed over exactly once`);
    const receipt = readReceipts(paths, id)?.receipts.lane;
    assert.ok(receipt?.deliveredAt != null, `"${body}" is archived only after its body was handed over`);
    // The body itself must be reachable in the handoff, not merely an id.
    assert.match(handed[0].text, new RegExp(body.replace(/ /g, " ")));
  }
  assert.equal(harness.sent.filter((entry) => entry.digest).length, 0, "no summary stands in for a body");
});

test("mail that keeps arriving at the old name after a rename is still delivered, once", async () => {
  const dir = base();
  configure(dir, { pollMs: 60_000 });
  const cwd = "/scratch/grace-lane";
  const harness = load(dir, { PI_SESSION_ID: "sess-grace" });
  const original = defaultName(cwd);
  await start(harness, "startup", cwd);
  await harness.tools
    .get("rooms_pins")
    .execute("pin", { action: "set", key: "session:sess-grace", name: "grace-renamed" }, undefined, undefined, ctx(cwd));
  assert.equal(harness.sent.length, 0, "nothing queued before the rename");

  // A peer that has not noticed the rename keeps addressing the old name.
  const lateId = queue(dir, original, { text: "addressed to the old name" });
  for (let i = 0; i < 60 && harness.sent.length === 0; i += 1) await sleep(100);
  await sleep(400); // long enough that a second drain would show up
  await harness.shutdown();

  const delivered = harness.sent.filter((entry) => entry.text.includes("addressed to the old name"));
  assert.equal(delivered.length, 1, "stranded mail is delivered, exactly once");
  assert.ok(
    readReceipts(resolvePaths(dir), lateId)?.receipts[original]?.deliveredAt != null,
    "and the receipt records it against the name it was addressed to",
  );
});

test("the grace drain stops once another live agent holds the old name", async () => {
  const dir = base();
  configure(dir, { pollMs: 60_000 });
  const paths = resolvePaths(dir);
  const cwd = "/scratch/grace-stop-lane";
  const harness = load(dir, { PI_SESSION_ID: "sess-grace-stop" });
  const original = defaultName(cwd);
  await start(harness, "startup", cwd);
  await harness.tools
    .get("rooms_pins")
    .execute("pin", { action: "set", key: "session:sess-grace-stop", name: "grace-stop-renamed" }, undefined, undefined, ctx(cwd));

  // A different live process now answers to the old name.
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const at = new Date().toISOString();
  register(paths, {
    name: original,
    pid: child.pid!,
    cwd: "/scratch/other",
    bootId: bootId() ?? undefined,
    procId: procIdentity(child.pid!) ?? undefined,
    startedAt: at,
    updatedAt: at,
  });

  try {
    queue(dir, original, { text: "theirs now" });
    // Two grace intervals: enough for a drain that wrongly kept going.
    await sleep(2600);
    await harness.shutdown();
    assert.equal(
      harness.sent.filter((entry) => entry.text.includes("theirs now")).length,
      0,
      "a name another live agent has taken is theirs to read, not ours",
    );
  } finally {
    child.kill();
  }
});

test("a takeover between batches stops the queued continuation, not just the interval", async () => {
  const dir = base();
  configure(dir, { pollMs: 60_000 });
  const paths = resolvePaths(dir);
  const cwd = "/scratch/takeover-lane";
  const harness = load(dir, { PI_SESSION_ID: "sess-takeover" });
  const original = defaultName(cwd);
  await start(harness, "startup", cwd);
  await harness.tools
    .get("rooms_pins")
    .execute("pin", { action: "set", key: "session:sess-takeover", name: "takeover-renamed" }, undefined, undefined, ctx(cwd));
  assert.equal(harness.sent.length, 0, "nothing queued before the rename");

  // 12 messages to the abandoned name: one grace batch of 5, then a continuation.
  for (let i = 0; i < 12; i += 1) queue(dir, original, { index: i, text: `takeover ${i}` });

  // Wait for the grace interval's first bounded batch.
  for (let i = 0; i < 40 && harness.sent.length < 5; i += 1) await sleep(50);
  const beforeTakeover = harness.sent.length;
  assert.equal(beforeTakeover, 5, "the first grace batch is bounded to maxDeliverPerFlush");

  // A different live process takes the name *now* — after the batch, before the
  // 250ms continuation fires.
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const at = new Date().toISOString();
  register(paths, {
    name: original,
    pid: child.pid!,
    cwd: "/scratch/other",
    bootId: bootId() ?? undefined,
    procId: procIdentity(child.pid!) ?? undefined,
    startedAt: at,
    updatedAt: at,
  });

  try {
    assert.ok(
      listAgents(paths).some((agent) => agent.name === original && agent.pid === child.pid),
      "the foreign holder is live and visible to the store",
    );
    await sleep(1400); // several continuations and one grace interval
    assert.equal(
      harness.sent.length,
      beforeTakeover,
      `no handoff after takeover (was ${beforeTakeover}, now ${harness.sent.length})`,
    );
    const remaining = fs.readdirSync(path.join(dir, "inbox", original)).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 7, "the rest is left in the inbox for its new owner, not drained");
  } finally {
    child.kill();
    await harness.shutdown();
  }
});

test("a takeover inside a batch stops the rest of that batch", async () => {
  const dir = base();
  configure(dir, { pollMs: 60_000 });
  const paths = resolvePaths(dir);
  const cwd = "/scratch/within-batch-lane";
  const original = defaultName(cwd);
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  let registeredDuring: number | null = null;

  const harness = load(
    dir,
    { PI_SESSION_ID: "sess-within" },
    {
      // A whole batch is handed over synchronously; a claim that lands while it is
      // running must stop the rest of it, not the next batch.
      onSend: (index) => {
        if (index !== 1) return;
        const at = new Date().toISOString();
        register(paths, {
          name: original,
          pid: child.pid!,
          cwd: "/scratch/other",
          bootId: bootId() ?? undefined,
          procId: procIdentity(child.pid!) ?? undefined,
          startedAt: at,
          updatedAt: at,
        });
        registeredDuring = index;
      },
    },
  );

  try {
    await start(harness, "startup", cwd);
    await harness.tools
      .get("rooms_pins")
      .execute("pin", { action: "set", key: "session:sess-within", name: "within-renamed" }, undefined, undefined, ctx(cwd));
    for (let i = 0; i < 12; i += 1) queue(dir, original, { index: i, text: `within ${i}` });

    for (let i = 0; i < 60 && harness.sent.length < 2; i += 1) await sleep(50);
    await sleep(600); // past the continuation that the interrupted batch would have queued
    await sleep(900); // and past the next grace interval

    assert.equal(registeredDuring, 1, "the holder was registered during the second handoff");
    assert.ok(
      listAgents(paths).some((agent) => agent.name === original && agent.pid === child.pid),
      "the holder is live",
    );
    assert.equal(
      harness.sent.length,
      2,
      `only the handoffs made before the takeover stand (got ${harness.sent.length})`,
    );
    const remaining = fs.readdirSync(path.join(dir, "inbox", original)).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 10, "the untouched remainder is left for the holder");
    // What was handed over keeps its receipt; nothing else does.
    const delivered = fs
      .readdirSync(path.join(dir, "inbox", original, "read"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "inbox", original, "read", f), "utf8")) as {
        id: string;
        deliveredAt?: string;
      });
    // One stamped copy per successful handoff: the renamed original has no
    // deliveredAt, only the <id>.json copy does.
    assert.equal(
      delivered.filter((message) => message.deliveredAt != null).length,
      harness.sent.length,
      "each handoff that was made keeps its delivered receipt",
    );
  } finally {
    child.kill();
    await harness.shutdown();
  }
});

test("a holder that leaves before the next grace tick does not restart delivery", async () => {
  const dir = base();
  configure(dir, { pollMs: 60_000 });
  const paths = resolvePaths(dir);
  const cwd = "/scratch/transient-lane";
  const original = defaultName(cwd);
  const harness = load(dir, { PI_SESSION_ID: "sess-transient" });
  const child = spawn("sleep", ["30"], { stdio: "ignore" });

  try {
    await start(harness, "startup", cwd);
    await harness.tools
      .get("rooms_pins")
      .execute("pin", { action: "set", key: "session:sess-transient", name: "transient-renamed" }, undefined, undefined, ctx(cwd));
    for (let i = 0; i < 12; i += 1) queue(dir, original, { index: i, text: `transient ${i}` });

    for (let i = 0; i < 40 && harness.sent.length < 5; i += 1) await sleep(50);
    assert.equal(harness.sent.length, 5, "first grace batch");

    // The holder appears and is seen by the pending continuation...
    const at = new Date().toISOString();
    register(paths, {
      name: original,
      pid: child.pid!,
      cwd: "/scratch/other",
      bootId: bootId() ?? undefined,
      procId: procIdentity(child.pid!) ?? undefined,
      startedAt: at,
      updatedAt: at,
    });
    await sleep(400); // past the 250ms continuation, before the next 1s grace tick

    // ...and is gone again before that tick. The window must already be closed.
    unregister(paths, original);
    child.kill();
    await sleep(1500); // two grace intervals' worth

    assert.equal(
      harness.sent.length,
      5,
      `a holder that is briefly present must still end the drain (got ${harness.sent.length})`,
    );
    const remaining = fs.readdirSync(path.join(dir, "inbox", original)).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 7, "and the rest stays queued");
  } finally {
    child.kill();
    await harness.shutdown();
  }
});
