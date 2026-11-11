import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { deliver, drain, isValidName, listAgents, procIdentity, readReceipts, readRegistration, register, resolvePaths, sameProcessStart } from "../src/store.ts";
import { pinPath, readPinFile, writePinFile } from "../src/pins.ts";

function sandbox(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function lane(t: any, dir: string, options: { name?: string; session?: string; pane?: string; cwd?: string; envSession?: string; tab?: string; workspace?: string; model?: string } = {}) {
  const env = { ...process.env };
  for (const key of ["PI_ROOMS_NAME", "PI_AGENT_NAME", "PI_SESSION_ID", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) delete env[key];
  Object.assign(env, { PI_ROOMS_DIR: dir, TEST_CWD: options.cwd ?? `${dir}/work-${Math.random()}` });
  if (options.name) env.PI_ROOMS_NAME = options.name;
  if (options.session) env.TEST_SESSION_ID = options.session;
  else delete env.TEST_SESSION_ID;
  if (options.envSession) env.PI_SESSION_ID = options.envSession;
  if (options.pane) env.HERDR_PANE_ID = options.pane;
  if (options.tab) env.HERDR_TAB_ID = options.tab;
  if (options.workspace) env.HERDR_WORKSPACE_ID = options.workspace;
  if (options.model) env.PI_MODEL = options.model;
  const child = fork(fileURLToPath(new URL("./fixtures/identity-lane.ts", import.meta.url)), [], {
    env, execArgv: process.execArgv, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (data) => { stderr += data; });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let seq = 0;
  let armed: (() => void) | undefined;
  child.on("message", (message: any) => {
    if (message.armed) armed?.();
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  child.on("exit", () => {
    for (const request of pending.values()) request.reject(new Error(`lane exited: ${stderr}`));
    pending.clear();
  });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`lane ready timeout: ${stderr}`)), 10_000);
    child.once("error", reject);
    child.once("message", (message: any) => {
      clearTimeout(timer);
      assert.equal(message.ready, true);
      resolve();
    });
  });
  function request(data: any): Promise<any> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`lane request timeout: ${stderr}`)); }, 15_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.send({ ...data, id });
    });
  }
  return {
    child, pid: child.pid!,
    start: (barrier?: string, reason?: string) => request({ op: "start", barrier, reason }),
    startOnly: () => request({ op: "start-only" }),
    sent: () => request({ op: "sent" }),
    arm: () => new Promise<void>((resolve) => { armed = resolve; }),
    call: (tool: string, params: any = {}) => request({ op: "call", tool, params }),
    stop: async () => {
      const exited = once(child, "exit");
      await request({ op: "shutdown" });
      await exited;
    },
  };
}
function pins(dir: string, values: Record<string, any>) { writePinFile(resolvePaths(dir), { pins: values }); }
function names(dir: string) { return listAgents(resolvePaths(dir)).map((entry) => entry.name); }
function self(result: any): string { return result.details.self; }

for (const invalidation of ["foreign-pane", "cwd-ambiguity", "pin-removal"] as const) {
  for (const inspectBeforeJoin of [false, true]) {
    test(`deferred revocation ${invalidation}; ${inspectBeforeJoin ? "inspect then join" : "direct first join"}`, async (t) => {
      const dir = sandbox(t);
      const paths = resolvePaths(dir);
      const cwd = `${dir}/work`;
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ autoJoin: false, pollMs: 10 }));
      const a = await lane(t, dir, { cwd, pane: "reused", session: "deferred" });
      await a.startOnly();
      const derived = self(await a.call("rooms_who"));
      const key = invalidation === "cwd-ambiguity" ? `cwd:${cwd}` : "pane:reused";
      const obsolete = "guarded-intent";
      pins(dir, { [key]: { name: obsolete } });
      assert.equal(self(await a.call("rooms_who")), obsolete, "cache an initially eligible intent without claiming");
      assert.equal(readPinFile(paths).pins[key].procId, undefined);
      assert.deepEqual(fs.existsSync(paths.registry) ? fs.readdirSync(paths.registry) : [], []);

      let b: Awaited<ReturnType<typeof lane>> | undefined;
      if (invalidation === "foreign-pane") {
        b = await lane(t, dir, { cwd: `${dir}/other`, pane: "reused" });
        await b.startOnly();
        await b.call("rooms_create", { room: "foreign", members: [] });
        const foreignStamp = readPinFile(paths).pins[key].procId!;
        assert.ok(sameProcessStart(foreignStamp, procIdentity(b.pid)!));
        await b.stop();
      } else if (invalidation === "cwd-ambiguity") {
        b = await lane(t, dir, { cwd, name: "cwd-peer" });
        await b.startOnly();
        await b.call("rooms_create", { room: "peer", members: [] });
      } else {
        pins(dir, {});
      }
      const pinBytes = fs.readFileSync(pinPath(paths), "utf8");
      const id = "cccccccc-1234";
      deliver(paths, { id, from: "peer", to: [obsolete], text: "must stay queued", sentAt: new Date().toISOString() });
      const queued = drain(paths, obsolete)[0];
      const queueBytes = fs.readFileSync(queued.file, "utf8");
      if (inspectBeforeJoin) {
        assert.equal(self(await a.call("rooms_who")), derived, "inspection must discard ineligible cached intent");
        const listed = await a.call("rooms_pins");
        if (invalidation === "foreign-pane") assert.match(listed.content[0].text, /different process/);
        if (invalidation === "cwd-ambiguity") assert.match(listed.content[0].text, /ambiguous/);
      }
      await a.call("rooms_create", { room: "joined", members: [] });
      // Read raw records before any inspection could re-register the lane.
      assert.equal(readRegistration(paths, derived)?.pid, a.pid);
      assert.equal(readRegistration(paths, obsolete), null, "no obsolete ownership, even transiently repaired by inspection");
      assert.equal(readRegistration(paths, derived)?.sessionId, "deferred");
      assert.equal(fs.readFileSync(pinPath(paths), "utf8"), pinBytes, "no obsolete pin stamp or foreign-stamp overwrite");
      assert.equal(fs.readFileSync(queued.file, "utf8"), queueBytes, "obsolete mailbox stays byte-identical");
      assert.equal(readReceipts(paths, id)?.receipts[obsolete].deliveredAt, undefined);
      assert.deepEqual(await a.sent(), [], "no delivery or rename-grace drain of rejected intent");
      assert.equal(self(await a.call("rooms_who")), derived);
      await a.stop();
      if (invalidation === "cwd-ambiguity") await b!.stop();
      assert.deepEqual(fs.readdirSync(paths.registry), []);
    });
  }
}

for (const first of ["holder", "suffix"] as const) {
  test(`A1-A3 explicit collision; ${first} shuts down first`, async (t) => {
    const dir = sandbox(t);
    const a = await lane(t, dir, { name: "shared" });
    assert.equal(self(await a.start()), "shared");
    const b = await lane(t, dir, { name: "shared" });
    assert.equal(self(await b.start()), `shared-${b.pid}`);
    assert.deepEqual(names(dir), ["shared", `shared-${b.pid}`]);
    const [departing, survivor] = first === "holder" ? [a, b] : [b, a];
    await departing.stop();
    const who = await survivor.call("rooms_who");
    assert.equal(who.details.agents.length, 1);
    assert.equal(who.details.agents[0].pid, survivor.pid);
    assert.equal(self(who), first === "holder" ? `shared-${b.pid}` : "shared");
    await survivor.stop();
    assert.deepEqual(names(dir), []);
  });
}

test("A4/A8 foreign live registration survives shutdown and rename release", async (t) => {
  const dir = sandbox(t);
  const a = await lane(t, dir, { pane: "test:p1" });
  const original = self(await a.start());
  const foreign = await lane(t, dir, { name: "other" });
  await foreign.start();
  const paths = resolvePaths(dir);
  // Simulate a foreign writer/stale state outside the cooperating claim API.
  fs.writeFileSync(path.join(paths.registry, `${original}.json`), JSON.stringify({ ...readRegistration(paths, original)!, pid: foreign.pid, procId: procIdentity(foreign.pid)! }));
  pins(dir, { "pane:test:p1": { name: "renamed" } });
  assert.equal(self(await a.call("rooms_who")), "renamed");
  assert.equal(readRegistration(paths, original)?.pid, foreign.pid);
  fs.writeFileSync(path.join(paths.registry, "renamed.json"), JSON.stringify({ ...readRegistration(paths, "renamed")!, pid: foreign.pid, procId: procIdentity(foreign.pid)! }));
  await a.stop();
  assert.equal(readRegistration(paths, "renamed")?.pid, foreign.pid);
});

for (const keyType of ["pane", "session"]) {
  test(`A5/A6/A9/A11 ${keyType} held live stays suffixed and never stamps pin`, async (t) => {
    const dir = sandbox(t);
    const holder = await lane(t, dir, { name: "contested" });
    await holder.start();
    const key = `${keyType}:id`;
    const oldStamp = keyType === "session" ? "1:R" : undefined;
    pins(dir, { [key]: { name: "contested", procId: oldStamp } });
    const adopter = await lane(t, dir, { pane: "id", session: "id" });
    const effective = `contested-${adopter.pid}`;
    assert.equal(self(await adopter.start()), effective);
    assert.equal(readPinFile(resolvePaths(dir)).pins[key].procId, oldStamp);
    await adopter.call("rooms_create", { room: "keep", members: [] });
    await holder.stop();
    assert.equal(self(await adopter.call("rooms_who")), effective, "transient holder exit is not a rename intent");
    assert.equal(readPinFile(resolvePaths(dir)).pins[key].procId, oldStamp);
    const post = await adopter.call("rooms_post", { room: "keep", message: "still a member" });
    assert.notEqual(post.isError, true);
    await adopter.stop();
    const next = await lane(t, dir, { pane: "id", session: "id" });
    assert.equal(self(await next.start()), "contested", "restart re-resolves the original intent");
    assert.ok(sameProcessStart(readPinFile(resolvePaths(dir)).pins[key].procId!, procIdentity(next.pid)!));
  });
}

test("A7/A8/A12/A13 session startup, direct mid-session pin, resume and ctx precedence", async (t) => {
  const dir = sandbox(t);
  pins(dir, { "session:stable": { name: "session-lane", procId: "1:R" }, "session:wrong-env": { name: "wrong" } });
  const a = await lane(t, dir, { session: "stable", envSession: "wrong-env" });
  assert.equal(self(await a.start()), "session-lane");
  assert.equal(readRegistration(resolvePaths(dir), "session-lane")?.sessionId, "stable");
  assert.ok(sameProcessStart(readPinFile(resolvePaths(dir)).pins["session:stable"].procId!, procIdentity(a.pid)!));
  pins(dir, { "session:stable": { name: "renamed-session" } });
  const who = await a.call("rooms_who");
  assert.equal(self(who), "renamed-session");
  assert.deepEqual(names(dir), ["renamed-session"]);
  await a.stop();
  const b = await lane(t, dir, { session: "stable" });
  assert.equal(self(await b.start(undefined, "resume")), "renamed-session");
  assert.ok(sameProcessStart(readPinFile(resolvePaths(dir)).pins["session:stable"].procId!, procIdentity(b.pid)!));
});

for (const reason of ["new", "fork"]) {
  test(`A14 ${reason} with new session id does not inherit session pin`, async (t) => {
    const dir = sandbox(t);
    pins(dir, { "session:old": { name: "old-session" } });
    const a = await lane(t, dir, { session: `new-${reason}` });
    assert.notEqual(self(await a.start(undefined, reason)), "old-session");
    assert.equal(readPinFile(resolvePaths(dir)).pins["session:old"].procId, undefined);
  });
}

test("A10/A11 rooms_pins replies honestly and preserves room refusal/force", async (t) => {
  const dir = sandbox(t);
  const a = await lane(t, dir, { session: "mine" });
  await a.start();
  const free = await a.call("rooms_pins", { action: "set", key: "this", name: "free-name" });
  assert.match(free.content[0].text, /now free-name/);
  assert.deepEqual(names(dir), ["free-name"]);
  await a.call("rooms_create", { room: "guard", members: [] });
  const holder = await lane(t, dir, { name: "taken" });
  await holder.start();
  const denied = await a.call("rooms_pins", { action: "set", key: "this", name: "taken" });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Refusing to rename/);
  const forced = await a.call("rooms_pins", { action: "set", key: "this", name: "taken", force: true });
  assert.match(forced.content[0].text, new RegExp(`now taken-${a.pid}\\.`));
  assert.equal(readPinFile(resolvePaths(dir)).pins["session:mine"].procId, undefined);
  assert.equal(readRegistration(resolvePaths(dir), "taken")?.pid, holder.pid);
});

for (const type of ["pane", "cwd"]) {
  test(`A15 ${type} foreign proc guard is preserved`, async (t) => {
    const dir = sandbox(t);
    const cwd = `${dir}/work`;
    pins(dir, { [`${type}:${type === "pane" ? "id" : cwd}`]: { name: "not-inherited", procId: "1:R" } });
    const a = await lane(t, dir, { pane: "id", cwd });
    assert.notEqual(self(await a.start()), "not-inherited");
    assert.match((await a.call("rooms_pins")).content[0].text, /different process/);
  });
}

test("A16 cwd ambiguity refusal and A17 derived collision", async (t) => {
  const dir = sandbox(t);
  const cwd = `${dir}/same-work`;
  const a = await lane(t, dir, { cwd });
  const derived = self(await a.start());
  const b = await lane(t, dir, { cwd });
  assert.equal(self(await b.start()), `${derived}-${b.pid}`);
  pins(dir, { [`cwd:${cwd}`]: { name: "ambiguous" } });
  assert.notEqual(self(await b.call("rooms_who")), "ambiguous");
  assert.match((await b.call("rooms_pins")).content[0].text, /ambiguous/);
});

test("V7 compatibility env fallback when ctx has no session id", async (t) => {
  const dir = sandbox(t);
  pins(dir, { "session:fallback": { name: "env-fallback" } });
  const a = await lane(t, dir, { envSession: "fallback" });
  assert.equal(self(await a.start()), "env-fallback");
});

for (const long of [false, true]) {
for (const kind of ["explicit", "pane", "session", "derived"] as const) {
  for (const shutdownFirst of ["clean", "suffix"] as const) {
    test(`A20 concurrent real-pid barrier ${long ? "long" : "short"} ${kind}; ${shutdownFirst} exits first`, async (t) => {
      // Repeated shared-file releases, not sequential IPC starts. Both processes
      // are armed inside the driver before a single filesystem release.
      for (let round = 0; round < (long ? 1 : 3); round += 1) {
        const dir = sandbox(t);
        const cwd = `${dir}/${long ? "w".repeat(80) : "work"}`;
        const wanted = long ? "r".repeat(48) : "race";
        if (kind === "pane") pins(dir, { "pane:a": { name: wanted }, "pane:b": { name: wanted } });
        if (kind === "session") pins(dir, { "session:a": { name: wanted }, "session:b": { name: wanted } });
        const a = await lane(t, dir, { cwd, name: kind === "explicit" ? wanted : undefined, pane: "a", session: "a" });
        const b = await lane(t, dir, { cwd, name: kind === "explicit" ? wanted : undefined, pane: "b", session: "b" });
        assert.notEqual(a.pid, b.pid);
        const barrier = path.join(dir, "go");
        const armedA = a.arm();
        const armedB = b.arm();
        const started = Promise.all([a.start(barrier), b.start(barrier)]);
        await Promise.all([armedA, armedB]);
        fs.writeFileSync(barrier, "go");
        const [whoA, whoB] = await started;
        const nameA = self(whoA);
        const nameB = self(whoB);
        assert.notEqual(nameA, nameB, "one exclusive winner, never a shared mailbox");
        assert.ok(isValidName(nameA) && isValidName(nameB), "full suffix fits the 48-character name limit");
        const paths = resolvePaths(dir);
        assert.equal(readRegistration(paths, nameA)?.pid, a.pid);
        assert.equal(readRegistration(paths, nameB)?.pid, b.pid);
        assert.equal(names(dir).length, 2, "no duplicate or ghost registrations");
        const aIsSuffix = nameA.endsWith(`-${a.pid}`);
        assert.equal(nameB.endsWith(`-${b.pid}`), !aIsSuffix);
        const clean = aIsSuffix ? b : a;
        const suffix = aIsSuffix ? a : b;
        const [departing, survivor] = shutdownFirst === "clean" ? [clean, suffix] : [suffix, clean];
        await departing.stop();
        const remaining = fs.readdirSync(paths.registry);
        assert.equal(remaining.length, 1, "survivor exists on disk before any tool can republish");
        assert.equal(JSON.parse(fs.readFileSync(path.join(paths.registry, remaining[0]), "utf8")).pid, survivor.pid);
        const after = await survivor.call("rooms_who");
        assert.equal(after.details.agents.length, 1);
        assert.equal(after.details.agents[0].pid, survivor.pid, "survivor registration cannot be lost");
        await survivor.stop();
        assert.deepEqual(names(dir), []);
        assert.deepEqual(fs.readdirSync(paths.registry), [], "no leftover locks or temps");
      }
    });
  }
}
}

test("atomic refresh rejects foreign live holder; guarded release cannot delete it", async (t) => {
  const dir = sandbox(t);
  const a = await lane(t, dir, { name: "guarded" });
  await a.start();
  const paths = resolvePaths(dir);
  assert.throws(() => register(paths, { ...readRegistration(paths, "guarded")!, pid: process.pid }), /held by live pid/);
  assert.equal(readRegistration(paths, "guarded")?.pid, a.pid);
});

for (const kind of ["explicit", "pane", "session", "derived"] as const) {
  for (const first of ["holder", "contender"]) {
    test(`long ${kind} secondary suffix includes retry counter; ${first} exits first`, async (t) => {
      const dir = sandbox(t);
      const paths = resolvePaths(dir);
      const cwd = `${dir}/${"w".repeat(80)}`;
      const wanted = "r".repeat(48);
      if (kind === "pane") pins(dir, { "pane:a": { name: wanted }, "pane:b": { name: wanted } });
      if (kind === "session") pins(dir, { "session:a": { name: wanted }, "session:b": { name: wanted } });
      const options = { cwd, name: kind === "explicit" ? wanted : undefined };
      const holder = await lane(t, dir, { ...options, pane: "a", session: "a" });
      const base = self(await holder.start());
      const contender = await lane(t, dir, { ...options, pane: "b", session: "b" });
      const at = new Date().toISOString();
      const occupied: string[] = [];
      // Force both ordinary suffix and retries through a two-digit counter.
      for (let retry = 0; retry < 12; retry += 1) {
        const suffix = retry === 0 ? `-${contender.pid}` : `-${contender.pid}-${retry}`;
        const name = `${base.slice(0, 48 - suffix.length)}${suffix}`;
        occupied.push(name);
        register(paths, { name, pid: process.pid, cwd: "/blocker", startedAt: at, updatedAt: at });
      }
      const suffix = `-${contender.pid}-12`;
      const effective = `${base.slice(0, 48 - suffix.length)}${suffix}`;
      assert.equal(self(await contender.start()), effective);
      assert.ok(isValidName(effective));
      if (kind === "pane" || kind === "session") {
        assert.equal(readPinFile(paths).pins[`${kind}:b`].procId, undefined, "retry contender never stamps a pin it did not take");
      }
      const [departing, survivor] = first === "holder" ? [holder, contender] : [contender, holder];
      await departing.stop();
      const survivorName = first === "holder" ? effective : base;
      assert.equal(readRegistration(paths, survivorName)?.pid, survivor.pid);
      assert.equal(self(await survivor.call("rooms_who")), survivorName);
      for (const name of occupied) assert.equal(readRegistration(paths, name)?.pid, process.pid);
      await survivor.stop();
      assert.deepEqual(fs.readdirSync(paths.registry).sort(), occupied.map((name) => `${name}.json`).sort());
    });
  }
}

for (const held of [false, true]) {
for (const kind of ["explicit", "pane", "session", "derived"] as const) {
  test(`autoJoin false ${kind} ${held ? "held" : "free"}: no startup publication or drain; explicit join publishes full metadata`, async (t) => {
    const dir = sandbox(t);
    const paths = resolvePaths(dir);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ autoJoin: false, pollMs: 10 }));
    const cwd = `${dir}/work`;
    if (kind === "pane") pins(dir, { "pane:mine": { name: "deferred" } });
    if (kind === "session") pins(dir, { "session:mine": { name: "deferred" } });
    const a = await lane(t, dir, { cwd, name: kind === "explicit" ? "deferred" : undefined,
      pane: "mine", session: "mine", tab: "test-tab", workspace: "test-workspace", model: "test-model" });
    const started = await a.startOnly();
    assert.deepEqual(started.sent, []);
    const rawFiles = () => fs.existsSync(paths.registry) ? fs.readdirSync(paths.registry) : [];
    assert.deepEqual(rawFiles(), [], "raw registry empty immediately after session_start alone");
    const desired = self(await a.call("rooms_who"));
    assert.deepEqual(rawFiles(), [], "inspection still does not publish presence");
    if (kind === "pane" || kind === "session") {
      assert.equal(readPinFile(paths).pins[`${kind}:mine`].procId, undefined, "no unowned pin stamp");
    }
    deliver(paths, { id: "aaaaaaaa-1234", from: "peer", to: [desired], text: "not yours yet", sentAt: new Date().toISOString() });
    assert.deepEqual((await a.startOnly()).sent, [], "session_start must not flush queued mail under unowned intent");
    assert.deepEqual(rawFiles(), [], "repeated startup still does not claim presence");
    assert.deepEqual(await a.sent(), [], "no watcher/flush under unowned intent");
    assert.equal(drain(paths, desired).length, 1);
    const holder = held ? await lane(t, dir, { name: desired }) : null;
    if (holder) {
      await holder.startOnly();
      await holder.call("rooms_create", { room: "holder", members: [] });
    }
    await a.call("rooms_create", { room: "joined", members: [] });
    const effective = self(await a.call("rooms_who"));
    assert.equal(effective, held ? `${desired}-${a.pid}` : desired);
    assert.equal((await a.sent()).length, held ? 0 : 1, "join drains only the name actually claimed, never an unowned intent");
    if (!held && (kind === "pane" || kind === "session")) {
      assert.ok(sameProcessStart(readPinFile(paths).pins[`${kind}:mine`].procId!, procIdentity(a.pid)!));
    }
    const entry = readRegistration(paths, effective)!;
    assert.equal(entry.pid, a.pid);
    assert.equal(entry.cwd, cwd);
    assert.equal(entry.sessionId, "mine");
    assert.equal(entry.paneId, "mine");
    assert.equal(entry.tabId, "test-tab");
    assert.equal(entry.workspaceId, "test-workspace");
    assert.equal(entry.model, "test-model");
    assert.ok(entry.bootId && entry.procId && entry.startedAt && entry.updatedAt);
    assert.ok(sameProcessStart(entry.procId, procIdentity(a.pid)!));
    await a.stop();
    if (holder) {
      assert.equal(readRegistration(paths, desired)?.pid, holder.pid);
      await holder.stop();
    }
    assert.deepEqual(rawFiles(), []);
  });
}
}
