/**
 * Integration tests: load the real extension through a stub pi API and drive
 * its tool handlers. This is what catches wiring mistakes — a tool that is
 * registered but unreachable, a handler that throws, a delivery that never
 * lands — without needing a model or a live pi process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import init from "../index.ts";

import {
  archive,
  drain,
  readPosts,
  resolvePaths,
} from "../src/store.ts";

interface Recorded {
  tools: Map<string, any>;
  handlers: Map<string, Function>;
  sent: { content: string; customType: string }[];
}

function loadExtension(env: Record<string, string>): Recorded {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const recorded: Recorded = { tools: new Map(), handlers: new Map(), sent: [] };
  const pi = {
    registerTool: (def: any) => recorded.tools.set(def.name, def),
    registerCommand: () => {},
    on: (event: string, handler: Function) => {
      recorded.handlers.set(event, handler);
      return () => {};
    },
    sendMessage: (message: any) => recorded.sent.push({ content: message.content, customType: message.customType }),
    appendEntry: () => {},
  };
  init(pi as any);
  return recorded;
}

function ctx(cwd: string) {
  return { cwd, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } } as any;
}

async function call(ext: Recorded, name: string, params: unknown, cwd: string) {
  const tool = ext.tools.get(name);
  assert.ok(tool != null, `${name} should be registered`);
  return tool.execute("call-1", params, undefined, undefined, ctx(cwd));
}

function base(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-int-"));
}

test("registers the room and messaging tools", () => {
  const ext = loadExtension({ PI_ROOMS_DIR: base(), PI_ROOMS_NAME: "lead" });
  for (const name of [
    "rooms_who",
    "rooms_dm",
    "rooms_reply_all",
    "rooms_create",
    "rooms_join",
    "rooms_post",
    "rooms_read",
    "rooms_list",
  ]) {
    assert.ok(ext.tools.has(name), `${name} registered`);
  }
  assert.ok(ext.handlers.has("session_start"));
  assert.ok(ext.handlers.has("session_shutdown"));
});

test("a leader creates a room, posts, and history is readable with sequence numbers", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });

  const created = await call(ext, "rooms_create", { room: "dxdb", members: ["core", "testkit"] }, "/work/dxdb");
  assert.match(created.content[0].text, /Room dxdb created with 3 member/);

  const posted = await call(ext, "rooms_post", { room: "dxdb", message: "kickoff: m2-core first" }, "/work/dxdb");
  assert.match(posted.content[0].text, /#1/);

  const read = await call(ext, "rooms_read", { room: "dxdb" }, "/work/dxdb");
  assert.match(read.content[0].text, /#1 \d\d:\d\d lead: kickoff: m2-core first/);

  // The post fanned out to both other members' inboxes.
  assert.ok(fs.existsSync(path.join(dir, "inbox", "core")));
  assert.ok(fs.existsSync(path.join(dir, "inbox", "testkit")));
  assert.equal(fs.readdirSync(path.join(dir, "inbox", "core")).filter((f) => f.endsWith(".json")).length, 1);
});

test("posting to a room you are not in is refused, and joining fixes it", async () => {
  const dir = base();
  const lead = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  await call(lead, "rooms_create", { room: "neti", members: [] }, "/work/neti");

  // A second identity in the same process: one pi process is one agent, so a
  // second extension load is the smallest honest stand-in for a second lane.
  const outsider = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "neti-store" });
  const denied = await call(outsider, "rooms_post", { room: "neti", message: "hello" }, "/work/neti-worktrees/store");
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not a member/);

  const joined = await call(outsider, "rooms_join", { room: "neti" }, "/work/neti-worktrees/store");
  assert.equal(joined.isError, undefined);
  assert.match(joined.content[0].text, /Joined room neti \(2 members\): lead, neti-store/);

  const allowed = await call(outsider, "rooms_post", { room: "neti", message: "hello" }, "/work/neti-worktrees/store");
  assert.equal(allowed.isError, undefined);
  assert.match(allowed.content[0].text, /#1/);
});

test("duplicate room creation is refused rather than silently resetting membership", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  await call(ext, "rooms_create", { room: "r1", members: ["a"] }, "/work/x");
  const again = await call(ext, "rooms_create", { room: "r1", members: ["b"] }, "/work/x");
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /already exists/);
});

test("the send budget is unbounded unless the operator sets a cap", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  await call(ext, "rooms_create", { room: "b", members: [] }, "/work/x");
  // Default config: no cap, so a long run of sends must all succeed.
  for (let i = 0; i < 40; i += 1) {
    const sent = await call(ext, "rooms_post", { room: "b", message: `post ${i}` }, "/work/x");
    assert.equal(sent.isError, undefined, `send ${i} should not be capped`);
  }
});

test("an explicit cap is enforced and reports the limit", async () => {
  const dir = base();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxSendsPerSession: 2 }));
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  await call(ext, "rooms_create", { room: "b", members: [] }, "/work/x");

  assert.equal((await call(ext, "rooms_post", { room: "b", message: "one" }, "/work/x")).isError, undefined);
  assert.equal((await call(ext, "rooms_dm", { to: "core", message: "two" }, "/work/x")).isError, undefined);
  const third = await call(ext, "rooms_post", { room: "b", message: "three" }, "/work/x");
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /Send budget reached \(2\/2/);
});

test("reply_all from a room message posts into the room history", async () => {
  const dir = base();
  const lead = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  await call(lead, "rooms_create", { room: "tri", members: ["core"] }, "/work/tri");
  const posted = await call(lead, "rooms_post", { room: "tri", message: "who owns the migration?" }, "/work/tri");
  assert.match(posted.content[0].text, /#1/);

  // Stand in for the watcher having delivered and archived the post in core's inbox.
  const paths = resolvePaths(dir);
  const pending = drain(paths, "core");
  assert.equal(pending.length, 1);
  archive(paths, "core", pending[0].file, pending[0].message);
  const messageId = pending[0].message.id;

  const core = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "core" });
  const reply = await call(core, "rooms_reply_all", { messageId, message: "mine, until Friday" }, "/work/tri");
  assert.equal(reply.isError, undefined);
  assert.match(reply.content[0].text, /Replied in room tri at #2/);

  const history = readPosts(paths, "tri");
  assert.deepEqual(history.map((p) => `${p.seq}:${p.from}:${p.text}`), [
    "1:lead:who owns the migration?",
    "2:core:mine, until Friday",
  ]);

  // And the lead was pushed the reply.
  const leadInbox = drain(paths, "lead");
  assert.equal(leadInbox.length, 1);
  assert.equal(leadInbox[0].message.room, "tri");
  assert.equal(leadInbox[0].message.roomSeq, 2);
});

test("rooms_list shows membership and post counts", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  await call(ext, "rooms_create", { room: "a", members: ["core"] }, "/work/x");
  await call(ext, "rooms_post", { room: "a", message: "hi" }, "/work/x");
  const listed = await call(ext, "rooms_list", {}, "/work/x");
  assert.match(listed.content[0].text, /\* a\s+1 post\(s\)\s+lead, core/);
});

test("rooms_who reports this agent", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "plugin-eval" });
  await ext.handlers.get("session_start")!({}, ctx("/work/eval"));
  const who = await call(ext, "rooms_who", {}, "/work/eval");
  assert.match(who.content[0].text, /plugin-eval/);
});

test("read on an unknown room fails cleanly rather than throwing", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  const read = await call(ext, "rooms_read", { room: "ghost" }, "/work/x");
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /does not exist/);
});

test("messages cannot carry terminal escape sequences into the transcript", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "lead" });
  await call(ext, "rooms_create", { room: "esc", members: [] }, "/work/x");
  await call(ext, "rooms_post", { room: "esc", message: "safe\u001b[31mRED\u0000" }, "/work/x");
  const read = await call(ext, "rooms_read", { room: "esc" }, "/work/x");
  assert.equal(read.content[0].text.includes("\u001b"), false);
  assert.match(read.content[0].text, /safe\[31mRED/);
});

test("shutdown removes presence so the roster stays honest", async () => {
  const dir = base();
  const ext = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "temp-lane" });
  await ext.handlers.get("session_start")!({}, ctx("/work/temp"));
  assert.ok(fs.existsSync(path.join(dir, "registry", "temp-lane.json")));
  await ext.handlers.get("session_shutdown")!({}, ctx("/work/temp"));
  assert.equal(fs.existsSync(path.join(dir, "registry", "temp-lane.json")), false);
});
