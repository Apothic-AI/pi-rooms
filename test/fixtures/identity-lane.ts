/** Real-pid extension driver. All storage and identity are supplied by the test. */
import * as fs from "node:fs";
import init from "../../index.ts";

const tools = new Map<string, any>();
const handlers = new Map<string, Function>();
const sent: any[] = [];
const ctx = {
  cwd: process.env.TEST_CWD!, hasUI: false,
  sessionManager: { getSessionId: () => process.env.TEST_SESSION_ID },
  ui: { setStatus() {}, notify() {} },
};
init({
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand() {},
  on: (event: string, handler: Function) => handlers.set(event, handler),
  sendMessage: (message: any) => sent.push(message),
  appendEntry() {},
} as any);

process.on("message", async (request: any) => {
  try {
    let result: any;
    if (request.op === "start" || request.op === "start-only") {
      // Every process reports armed before the parent releases the shared barrier.
      if (request.barrier) {
        process.send!({ armed: true });
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(request.barrier)) {
          if (Date.now() > deadline) throw new Error("barrier timeout");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        }
      }
      await handlers.get("session_start")!({ reason: request.reason ?? "startup" }, ctx);
      result = request.op === "start-only" ? { sent: [...sent] } : await tools.get("rooms_who").execute("who", {}, undefined, undefined, ctx);
    } else if (request.op === "shutdown") {
      await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      process.send!({ id: request.id, result: "stopped" }, () => process.exit(0));
      return;
    } else if (request.op === "sent") {
      result = [...sent];
    } else {
      result = await tools.get(request.tool).execute("call", request.params ?? {}, undefined, undefined, ctx);
    }
    process.send!({ id: request.id, result, sent });
  } catch (error) {
    process.send!({ id: request.id, error: String(error) });
  }
});
process.send!({ ready: true, pid: process.pid });
