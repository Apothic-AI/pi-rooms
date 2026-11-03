/**
 * The relay and the loopback server: read-only by construction, loopback only.
 *
 * Every test here asserts a *structural* property rather than a behaviour that
 * happens to be safe today, because the operator's constraint was "read-only by
 * construction, not by discipline". The load-bearing tests are:
 *
 *   - no argv this module can build reaches a write verb, and none carries
 *     `--as`. That second half is not pedantry: in this CLI a `read` *with*
 *     `--as` is a write, because `run()` calls `writeLease()` before the verb
 *     and a bare `read --as NAME` drains and archives an inbox.
 *   - the server answers GET and refuses every other method, before routing.
 *   - it binds 127.0.0.1 and is unreachable on any other local address.
 *   - a full read session leaves the store byte-identical and mtime-identical.
 *
 * Nothing here touches `~/.pi/agent/rooms`. Every store is a `mkdtemp` named by
 * `PI_ROOMS_DIR`, and `assertNotLiveStore` refuses to run otherwise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ARGV,
  READ_VERBS,
  WRITE_VERBS,
  assertRoom,
  assertSince,
  childEnv,
  followRoom,
  readJsonVerb,
} from "../server/relay.ts";
import { BIND_HOST, startWebServer } from "../server/server.ts";
import { assertNotLiveStore, seed, snapshot, snapshotDiff, tempStore, OPERATOR, ROOM, TOKEN } from "./fixture.ts";

/**
 * Strip line and block comments from source.
 *
 * Used by the structural scans below so a comment *about* an absent writer
 * cannot be mistaken for the writer. Not a parser: it tracks strings and
 * templates so a `//` inside a literal is not treated as a comment, which is all
 * these assertions need.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote != null) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/* ── Argv reachability: the write path is absent, not disabled ───────────── */

test("bin/rooms's own write verbs are exactly the ones the relay may never run", () => {
  // Read the CLI's source rather than trusting a copy: if a verb grows a write
  // there, this list and the relay's allow-list diverge and this test says so.
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "bin", "rooms"),
    "utf8",
  );
  const match = source.match(/const WRITE_VERBS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(match != null, "bin/rooms must declare WRITE_VERBS");
  const declared = [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...WRITE_VERBS].sort(), declared.sort());
  for (const verb of WRITE_VERBS) {
    assert.ok(
      !(READ_VERBS as readonly string[]).includes(verb),
      `${verb} writes, so it must not be in the relay's reachable set`,
    );
  }
});

test("no argv the relay can build contains a write verb or --as", () => {
  const built = [
    ARGV.follow(ROOM, 0),
    ARGV.history(ROOM),
    ARGV.rooms(),
    ARGV.presence(),
    ARGV.participants(),
  ];
  for (const argv of built) {
    const verb = argv[0];
    assert.ok(
      (READ_VERBS as readonly string[]).includes(verb),
      `${verb} is not in the read-only allow-list`,
    );
    assert.ok(
      !(WRITE_VERBS as readonly string[]).includes(verb),
      `${verb} is a write verb and must be unreachable`,
    );
    assert.ok(
      !argv.includes("--as"),
      `an argv with --as is a write in this CLI (it writes a presence lease first): ${argv.join(" ")}`,
    );
    assert.ok(
      !argv.includes("--token"),
      `the relay has no identity and must never present a token: ${argv.join(" ")}`,
    );
  }
});

test("the room name is one argv element and cannot become syntax", () => {
  const hostile = "x; rm -rf ~ #";
  // It is rejected by validation...
  assert.throws(() => assertRoom(hostile), /not a valid room name/);
  // ...and even if it were not, it would be a single argv element with no shell
  // to interpret it. Assert the shape, since the shell:false is the real guard.
  const argv = ARGV.follow("ok-room", 0);
  assert.deepEqual(argv, ["read", "--room", "ok-room", "--since", "0", "--follow", "--json"]);
  assert.ok(argv.every((part) => typeof part === "string"));
});

test("--since is passed through untouched, and a bad one is refused", () => {
  assert.equal(assertSince(undefined), 0);
  assert.equal(assertSince("0"), 0);
  assert.equal(assertSince("17"), 17);
  for (const bad of ["-1", "1.5", "abc", "0x10"]) {
    assert.throws(() => assertSince(bad), /non-negative whole number/);
  }
});

test("the child environment is an allow-list, so a token in the server's env never reaches it", () => {
  const env = childEnv({
    HOME: "/home/x",
    PATH: "/usr/bin",
    PI_ROOMS_DIR: "/tmp/store",
    PI_ROOMS_CLIENT_TOKEN: "a-real-token",
    AWS_SECRET_ACCESS_KEY: "nope",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "PI_ROOMS_DIR"]);
});

/* ── The relay against a real store ──────────────────────────────────────── */

test("follow relays the CLI's NDJSON lines verbatim, in order, from the cursor", async () => {
  const store = tempStore();
  try {
    assertNotLiveStore(store.base);
    seed(store);
    process.env.PI_ROOMS_DIR = store.base;
    const relay = followRoom(ROOM, 0);
    const lines: string[] = [];
    relay.onLine((line) => lines.push(line));
    const exited = new Promise<number | null>((resolve) => relay.onExit((exit) => resolve(exit.code)));

    // Wait for the four backlog posts to arrive, then stop.
    const deadline = Date.now() + 15_000;
    while (lines.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    relay.stop();
    await exited;

    assert.equal(lines.length, 4, `expected the four backlog posts, got ${lines.length}`);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.deepEqual(parsed.map((p) => p.type), ["post", "post", "post", "post"]);
    assert.deepEqual(parsed.map((p) => p.seq), [1, 2, 3, 4]);
    // Verbatim: the line is exactly what the CLI wrote, no re-serialisation.
    for (const line of lines) assert.ok(line.startsWith('{"type":"post"'));
  } finally {
    delete process.env.PI_ROOMS_DIR;
    store.cleanup();
  }
});

test("a room that does not exist is an error with the writer's own words, not an empty stream", async () => {
  const store = tempStore();
  try {
    assertNotLiveStore(store.base);
    seed(store);
    process.env.PI_ROOMS_DIR = store.base;
    const relay = followRoom("no-such-room", 0);
    const exit = await new Promise<{ code: number | null; stderr: string }>((resolve) =>
      relay.onExit((e) => resolve({ code: e.code, stderr: e.stderr })),
    );
    assert.notEqual(exit.code, 0);
    assert.match(exit.stderr, /does not exist/);
  } finally {
    delete process.env.PI_ROOMS_DIR;
    store.cleanup();
  }
});

test("readJsonVerb reports a non-zero exit with its stderr instead of an empty result", async () => {
  const store = tempStore();
  try {
    assertNotLiveStore(store.base);
    const env = { ...process.env, PI_ROOMS_DIR: store.base };
    await assert.rejects(
      () => readJsonVerb("history", ["missing-room"], { env }),
      /does not exist/,
    );
  } finally {
    store.cleanup();
  }
});

/* ── The server: method gate and bind address ────────────────────────────── */

async function withServer<T>(fn: (ctx: { url: string; base: string }) => Promise<T>): Promise<T> {
  const store = tempStore();
  try {
    assertNotLiveStore(store.base);
    seed(store);
    const env = { ...process.env, PI_ROOMS_DIR: store.base };
    const server = await startWebServer({ port: 0, me: OPERATOR, env, silent: true });
    try {
      return await fn({ url: server.url, base: store.base });
    } finally {
      await server.close();
    }
  } finally {
    store.cleanup();
  }
}

test("the bind address is 127.0.0.1 and is not configurable", () => {
  assert.equal(BIND_HOST, "127.0.0.1");
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "server", "server.ts"), "utf8");
  assert.ok(!source.includes("0.0.0.0"), "0.0.0.0 must not appear anywhere in the server");
  // The only listen() call names the constant.
  const listens = [...source.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(listens.length, 1, "there must be exactly one listen()");
  assert.match(listens[0], /BIND_HOST/);
});

test("every method other than GET is refused before routing", async () => {
  await withServer(async ({ url }) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      const res = await fetch(url + "api/rooms", {
        method,
        body: method === "POST" || method === "PUT" || method === "PATCH" ? "{}" : undefined,
      });
      assert.ok(
        res.status === 405 || res.status === 501,
        `${method} must not be answered as a normal request (got ${res.status})`,
      );
      if (res.status === 405) assert.equal(res.headers.get("allow"), "GET");
    }
  });
});

test("no route accepts a write-shaped URL", async () => {
  await withServer(async ({ url }) => {
    for (const p of ["api/post", "api/dm", "api/ack", "api/join", "api/rooms/" + ROOM + "/post"]) {
      const res = await fetch(url + p);
      assert.equal(res.status, 404, `${p} must not exist`);
    }
  });
});

test("the store base is reported, so a reader can tell which store it is looking at", async () => {
  await withServer(async ({ url, base }) => {
    const res = await fetch(url + "api/config");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.storeBase, base);
    assert.equal(body.readOnly, true);
    assert.equal(body.host, "127.0.0.1");
  });
});

test("room history carries the four-rung receipt ladder, witness included", async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(url + `api/rooms/${ROOM}`);
    assert.equal(res.status, 200);
    // Typed at the boundary: `res.json()` is `any`, and an untyped shape here
    // would let the assertions below pass against a field that never existed.
    const body = (await res.json()) as {
      posts: Array<{ seq: number }>;
      receipts: Record<string, Array<{ recipient: string; state: string; witness: string }>>;
    };
    assert.equal(body.posts.length, 4);
    const ladders = Object.entries(body.receipts);
    const witness = ladders.find(([, ladder]) => ladder.some((entry) => entry.witness === "read-copy"));
    assert.ok(witness != null, "the witness case must survive the round trip");
    const states = new Set(ladders.flatMap(([, ladder]) => ladder.map((entry) => entry.state)));
    for (const state of ["queued", "delivered", "unknown"]) {
      assert.ok(states.has(state), `the fixture's ${state} rung must be reachable over HTTP`);
    }
  });
});

test("the inbox is read without being drained", async () => {
  await withServer(async ({ url, base }) => {
    const before = snapshot(base);
    const res = await fetch(url + "api/inbox");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.messages.length >= 2, "the seeded inbox has messages");
    const after = snapshot(base);
    assert.deepEqual(snapshotDiff(before, after), [], "reading the inbox must not touch the store");
  });
});

test("the inbox name is a startup setting, never a route parameter", async () => {
  const store = tempStore();
  try {
    assertNotLiveStore(store.base);
    seed(store);
    const env = { ...process.env, PI_ROOMS_DIR: store.base };
    // No --me: the inbox route refuses and says why.
    const server = await startWebServer({ port: 0, env, silent: true });
    try {
      const res = await fetch(server.url + "api/inbox");
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.kind, "no-identity");
      // And there is no way to name someone else. A path segment does not route
      // at all; a query string is *ignored*, so it answers the identical
      // `no-identity` refusal rather than honouring the name. Both are the same
      // claim: the inbox name is a startup setting, not a request parameter.
      const segment = await fetch(server.url + "api/inbox/fixture-agent");
      assert.equal(segment.status, 404, "a name in the path must not route");

      for (const q of ["?name=fixture-agent", "?me=fixture-agent", "?as=fixture-agent"]) {
        const query = await fetch(server.url + "api/inbox" + q);
        assert.equal(query.status, 400, `${q} must not be honoured`);
        assert.equal((await query.json()).error.kind, "no-identity", `${q} must change nothing`);
      }
    } finally {
      await server.close();
    }
  } finally {
    store.cleanup();
  }
});

test("SSE delivers the backlog as protocol lines and then the end frame", async () => {
  await withServer(async ({ url }) => {
    const controller = new AbortController();
    const res = await fetch(url + `api/rooms/${ROOM}/stream?since=0`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Array<{ event: string; data: string }> = [];

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (eventLine != null && dataLine != null) {
          events.push({ event: eventLine.slice(7), data: dataLine.slice(6) });
        }
        split = buffer.indexOf("\n\n");
      }
      if (events.some((e) => e.event === "relay" && JSON.parse(e.data).phase === "hello")
        && events.filter((e) => e.event === "rooms").length >= 4) break;
    }
    controller.abort();

    const hello = events.find((e) => e.event === "relay");
    assert.ok(hello != null);
    assert.equal(JSON.parse(hello.data).phase, "hello");
    assert.equal(JSON.parse(hello.data).readOnly, true);

    const posts = events.filter((e) => e.event === "rooms").map((e) => JSON.parse(e.data));
    assert.deepEqual(posts.map((p) => p.seq), [1, 2, 3, 4]);
    // The SSE data payload is the child's line, byte for byte.
    for (const event of events.filter((e) => e.event === "rooms")) {
      assert.ok(event.data.startsWith('{"type":"post"'), "protocol lines must be forwarded verbatim");
    }
  });
});

test("a bad room or a bad cursor is a 400 that names the reason", async () => {
  await withServer(async ({ url }) => {
    const badRoom = await fetch(url + "api/rooms/" + encodeURIComponent("Bad Room!"));
    assert.equal(badRoom.status, 400);
    assert.match((await badRoom.json()).error.message, /not a valid room name/);

    const badSince = await fetch(url + `api/rooms/${ROOM}/stream?since=-2`);
    assert.equal(badSince.status, 400);
    const body = await badSince.json();
    assert.equal(body.error.kind, "bad-since");
    assert.match(body.error.message, /non-negative whole number/);
  });
});

test("static files cannot escape their directory", async () => {
  await withServer(async ({ url }) => {
    for (const p of [
      "/../../../../etc/passwd",
      "/..%2f..%2f..%2f..%2fetc%2fpasswd",
      "/vendor/../../../package.json",
      "/%2e%2e/%2e%2e/package.json",
    ]) {
      const res = await fetch(url + p);
      assert.ok(res.status === 404 || res.status === 400, `${p} must not be served (got ${res.status})`);
      const text = await res.text();
      assert.ok(!text.includes("root:"), `${p} must not leak /etc/passwd`);
      assert.ok(!text.includes('"peerDependencies"'), `${p} must not leak package.json`);
    }
  });
});

/* ── The write-nothing proof ─────────────────────────────────────────────── */

test("a full read session leaves the store identical, byte for byte and mtime for mtime", async () => {
  await withServer(async ({ url, base }) => {
    const before = snapshot(base);
    assert.ok(before.length > 20, "the fixture must have a store to protect");

    // Everything the UI does, in the order it does it.
    const routes = [
      "api/config",
      "api/rooms",
      `api/rooms/${ROOM}`,
      "api/participants",
      "api/inbox",
      // Repeated, because a cache or a stamp would show up on the second pass.
      "api/rooms",
      `api/rooms/${ROOM}`,
      "api/inbox",
    ];
    for (const route of routes) {
      const res = await fetch(url + route);
      assert.equal(res.status, 200, `${route} should succeed`);
      await res.text();
    }

    // And a live stream, started and stopped, which spawns the real CLI.
    const controller = new AbortController();
    const stream = await fetch(url + `api/rooms/${ROOM}/stream?since=0`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    const deadline = Date.now() + 15_000;
    let seen = 0;
    let buffer = "";
    const decoder = new TextDecoder();
    while (seen < 4 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      seen = (buffer.match(/^event: rooms$/gm) ?? []).length;
    }
    controller.abort();
    // Give the server a moment to notice the closed socket and reap its child.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const after = snapshot(base);
    assert.deepEqual(
      snapshotDiff(before, after),
      [],
      "reading the store must not create, remove, or touch a single file",
    );
  });
});

test("the reader's own process contains no filesystem writer at all", () => {
  // The structural claim: `node:fs` is imported in exactly one module under
  // web/server, and that module has no write-capable function in it.
  const serverDir = path.join(import.meta.dirname, "..", "server");
  const importing: string[] = [];
  for (const file of fs.readdirSync(serverDir)) {
    if (!file.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(serverDir, file), "utf8");
    if (/from\s+["']node:fs["']/.test(source)) importing.push(file);
  }
  assert.deepEqual(importing, ["readonly-fs.ts"], "node:fs must be confined to the read-only module");

  // Comments are stripped before the scan on purpose: this module *documents*
  // the absent writers ("there is no writeFile, no mkdir"), and documentation of
  // an absence must not read as the presence it warns about. What is asserted is
  // that no code calls one.
  const fsModule = stripComments(fs.readFileSync(path.join(serverDir, "readonly-fs.ts"), "utf8"));
  for (const writer of [
    "writeFileSync",
    "writeFile",
    "appendFileSync",
    "mkdirSync",
    "rmSync",
    "unlinkSync",
    "renameSync",
    "copyFileSync",
    "createWriteStream",
    "truncateSync",
    "chmodSync",
    "utimesSync",
    "openSync",
  ]) {
    const uses = fsModule.split(writer).length - 1;
    assert.equal(uses, 0, `readonly-fs.ts must not call ${writer}`);
  }
});

test("only the relay spawns a process, so its argv is the whole reachable surface", () => {
  const serverDir = path.join(import.meta.dirname, "..", "server");
  const spawners: string[] = [];
  for (const file of fs.readdirSync(serverDir)) {
    if (!file.endsWith(".ts")) continue;
    const code = stripComments(fs.readFileSync(path.join(serverDir, file), "utf8"));
    if (/\bspawn\(/.test(code)) spawners.push(file);
  }
  // `relay.ts` is the only module that starts a child; `server.ts` asks the relay
  // for what it needs. So the set of argv that can ever reach `bin/rooms` is
  // exactly `ARGV` in relay.ts — which the earlier test enumerates and asserts on.
  assert.deepEqual(spawners, ["relay.ts"], "spawning must be confined to the relay");

  // And the browser bundle cannot spawn at all: it has no process API and no
  // module loader to reach one with.
  const publicDir = path.join(import.meta.dirname, "..", "public");
  const browserFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith(".js"));
  assert.ok(browserFiles.length > 0, "the client bundle must exist");
  for (const file of browserFiles) {
    const code = fs.readFileSync(path.join(publicDir, file), "utf8");
    assert.ok(!/node:child_process/.test(code), `${file} must not import a process API`);
    assert.ok(!/\brequire\(/.test(code), `${file} must not use require()`);
  }
});

test("the snapshot detector is sensitive: a real write is caught", () => {
  // Otherwise the write-nothing proof is vacuous. If `snapshot`/`snapshotDiff`
  // silently returned nothing, every "identical" assertion above would pass for
  // the wrong reason. So: perform one deliberate write through the real CLI and
  // require the detector to see it.
  const store = tempStore();
  try {
    assertNotLiveStore(store.base);
    seed(store);
    const before = snapshot(store.base);

    const result = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "..", "bin", "rooms"),
        "post", "--room", ROOM, "--as", OPERATOR, "--token", TOKEN,
        "a deliberate write, so the detector can be shown to work",
      ],
      { env: { ...process.env, PI_ROOMS_DIR: store.base }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `the CLI must succeed: ${result.stderr}`);

    const after = snapshot(store.base);
    const diff = snapshotDiff(before, after);
    assert.ok(diff.length > 0, "a real write must be visible to the detector");
    assert.ok(
      diff.some((d) => d.includes(`rooms/${ROOM}/log.jsonl`)),
      `the log append must be one of the diffs, got: ${diff.join(", ")}`,
    );
  } finally {
    store.cleanup();
  }
});
