import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import init from "../index.ts";
import { archive, deliver, drain, readReceipts, register, resolvePaths, unregister } from "../src/store.ts";

function harness(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-notice-"));
  const saved = { ...process.env };
  for (const key of ["PI_AGENT_NAME", "PI_SESSION_ID", "HERDR_PANE_ID"]) delete process.env[key];
  process.env.PI_ROOMS_DIR = dir;
  process.env.PI_ROOMS_NAME = "sender";
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const sent: any[] = [];
  init({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
    on: (event: string, handler: Function) => handlers.set(event, handler),
    sendMessage: (message: any) => sent.push(message), appendEntry() {},
  } as any);
  const ctx = { cwd: `${dir}/work`, hasUI: false };
  t.after(async () => {
    await handlers.get("session_shutdown")!({}, ctx);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, paths: resolvePaths(dir), sent,
    call: (name: string, params: any) => tools.get(name).execute("call", params, undefined, undefined, ctx) };
}
const body = (result: any) => result.content[0].text as string;

test("V3 DM absent-holder notice is once per observed condition; queue and receipts never expire", async (t) => {
  const h = harness(t);
  const first = await h.call("rooms_dm", { to: "absent", message: "preserve indefinitely" });
  assert.match(body(first), /No live holder observed for absent/);
  assert.match(body(first), /Queue preserved without expiry/);
  assert.equal(first.isError, undefined);
  assert.equal(drain(h.paths, "absent").length, 1);
  const queued = drain(h.paths, "absent")[0];
  const ancient = { ...queued.message, sentAt: "2000-01-01T00:00:00Z", queuedAt: "2000-01-01T00:00:00Z" };
  fs.writeFileSync(queued.file, JSON.stringify(ancient));
  const bytes = fs.readFileSync(queued.file, "utf8");
  for (let i = 0; i < 20; i += 1) {
    assert.doesNotMatch(body(await h.call("rooms_dm", { to: "absent", message: `still queued ${i}` })), /No live holder/);
  }
  await h.call("rooms_who", {});
  assert.equal(fs.readFileSync(queued.file, "utf8"), bytes, "no expiry, bounce, archival or deletion of old queue");
  assert.equal(drain(h.paths, "absent").length, 21);
  assert.equal(readReceipts(h.paths, first.details.id)?.receipts.absent.deliveredAt, undefined);
  assert.equal(h.sent.length, 0, "notice is a tool reply, not a wake or fake delivery");
  const at = new Date().toISOString();
  register(h.paths, { name: "absent", pid: process.pid, cwd: "/test", startedAt: at, updatedAt: at });
  assert.doesNotMatch(body(await h.call("rooms_dm", { to: "absent", message: "now live" })), /No live holder/);
  unregister(h.paths, "absent", process.pid);
  assert.match(body(await h.call("rooms_dm", { to: "absent", message: "absent again" })), /No live holder observed/);
});

test("V3 room post and both reply-all branches report absence, deduplicated across tools", async (t) => {
  const h = harness(t);
  await h.call("rooms_create", { room: "notice", members: ["room-peer"] });
  assert.match(body(await h.call("rooms_post", { room: "notice", message: "room message" })), /No live holder observed for room-peer/);
  assert.doesNotMatch(body(await h.call("rooms_post", { room: "notice", message: "again" })), /No live holder/);
  // Simulate a received room message from another room to exercise room reply-all.
  await h.call("rooms_create", { room: "reply", members: ["reply-peer"] });
  for (const [id, from, room] of [["aaaaaaaa-1111", "reply-peer", "reply"], ["bbbbbbbb-2222", "dm-peer", undefined]] as const) {
    deliver(h.paths, { id, from, to: ["sender"], text: "question", sentAt: new Date().toISOString(), room });
    const queued = drain(h.paths, "sender").find((entry) => entry.message.id === id)!;
    archive(h.paths, "sender", queued.file, queued.message);
    const reply = await h.call("rooms_reply_all", { messageId: id, message: "answer" });
    assert.match(body(reply), new RegExp(`No live holder observed for ${from}`));
    assert.equal(drain(h.paths, from).length, 1);
    assert.doesNotMatch(body(await h.call("rooms_dm", { to: from, message: "same absence" })), /No live holder/);
  }
});
