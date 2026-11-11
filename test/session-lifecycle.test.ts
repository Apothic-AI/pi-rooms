/** Verify the real supported session API, without launching pi or using live stores. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import init from "../index.ts";
import { readRegistration, resolvePaths, sameProcessStart, procIdentity } from "../src/store.ts";
import { readPinFile, writePinFile } from "../src/pins.ts";

test("A12-A14 real SessionManager resume/reload retains pin; new/fork do not", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-session-api-"));
  const saved = { ...process.env };
  for (const key of ["PI_ROOMS_NAME", "PI_AGENT_NAME", "PI_SESSION_ID", "HERDR_PANE_ID"]) delete process.env[key];
  process.env.PI_ROOMS_DIR = path.join(dir, "rooms");
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cwd = path.join(dir, "work");
  const manager = SessionManager.create(cwd, path.join(dir, "sessions"));
  const leaf = manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
  const originalId = manager.getSessionId();
  const file = manager.getSessionFile()!;
  assert.ok(fs.existsSync(file));
  const paths = resolvePaths(process.env.PI_ROOMS_DIR!);
  writePinFile(paths, { pins: { [`session:${originalId}`]: { name: "durable-session", procId: "1:R" } } });

  async function run(sessionManager: SessionManager, expected: boolean, reason: string) {
    const tools = new Map<string, any>();
    const handlers = new Map<string, Function>();
    init({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
      on: (event: string, handler: Function) => handlers.set(event, handler),
      sendMessage() {}, appendEntry() {},
    } as any);
    const ctx = { cwd, sessionManager, hasUI: false };
    try {
      await handlers.get("session_start")!({ reason }, ctx);
      const who = await tools.get("rooms_who").execute("call", {}, undefined, undefined, ctx);
      assert.equal(who.details.self === "durable-session", expected, reason);
      assert.equal(readRegistration(paths, who.details.self)?.sessionId, sessionManager.getSessionId());
    } finally { await handlers.get("session_shutdown")!({}, ctx); }
  }
  await run(SessionManager.open(file), true, "resume");
  await run(SessionManager.open(file), true, "reload");
  assert.ok(sameProcessStart(readPinFile(paths).pins[`session:${originalId}`].procId!, procIdentity(process.pid)!));
  const branched = manager.createBranchedSession(leaf)!;
  const forked = SessionManager.open(branched);
  assert.notEqual(forked.getSessionId(), originalId);
  await run(forked, false, "fork");
  manager.newSession();
  assert.notEqual(manager.getSessionId(), originalId);
  await run(manager, false, "new");
});
