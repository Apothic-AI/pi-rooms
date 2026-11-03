/**
 * The relay: it spawns `bin/rooms read --follow` and forwards its NDJSON.
 *
 * The operator's ruling of 2026-11-03T02:43Z is the whole specification, and it
 * is narrower than "an HTTP bridge": a loopback server that spawns
 * `bin/rooms read --follow` and relays its NDJSON stdout to the browser over
 * SSE. Nothing else. The protocol already exists and `S1` proves it end to end,
 * so this file deliberately contains no protocol code — it contains argv
 * construction, a child process, and a line splitter.
 *
 * Three properties are structural, not stylistic, and each has a test:
 *
 * 1. **No write verb is reachable, and `--as` never appears.** This is the part
 *    that looks like a technicality until you check: in this CLI a read *with
 *    `--as`* is not read-only. `run()` calls `writeLease()` before the verb
 *    runs, and a bare `read --as NAME` drains and archives the inbox. So the
 *    relay passes no `--as` at all, which is also what makes `list`, `presence`
 *    and `participants` safe: `writeLease` returns immediately on a null
 *    identity. There is no route that reaches a write verb, so "read-only" is a
 *    property of the reachable set, not a promise.
 * 2. **The room name reaches the child as its own argv element.** No shell, no
 *    quoting to get wrong, and validation through the store's own predicate
 *    rather than a second copy of `ROOM_RE` — a copy is a re-derivation, which
 *    is the failure this brief exists to prevent.
 * 3. **Nothing is buffered to be replayed.** stdout is split on newlines and
 *    each complete line is emitted as it arrives. The relay keeps no cursor:
 *    the browser's `?since=` is passed straight through, so the relay cannot
 *    invent a starting point and cannot re-deliver an old row as a new one.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidRoom } from "../../src/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The one writer a human uses. The relay only ever *reads* through it. */
export const ROOMS_BIN = path.resolve(HERE, "..", "..", "bin", "rooms");

/**
 * Verbs the relay may run. Frozen.
 *
 * A test asserts that none of these intersects `bin/rooms`'s own `WRITE_VERBS`,
 * so a verb that grows a write later cannot be picked up here silently.
 */
export const READ_VERBS = Object.freeze(["read", "list", "presence", "participants"] as const);

/** Verbs that write, mirrored from `bin/rooms`. Named so a test can compare the sets. */
export const WRITE_VERBS = Object.freeze(["post", "dm", "ack", "join"] as const);

/**
 * Environment entries the child inherits.
 *
 * An allow-list rather than a spread of `process.env`: the server's own
 * environment is not the child's business, and in particular a stray
 * `PI_ROOMS_CLIENT_TOKEN` in the server's environment must not reach a child
 * that has no business authenticating as anyone.
 */
const CHILD_ENV_KEYS = [
  "HOME",
  "PATH",
  "PI_ROOMS_DIR",
  "PI_ROOMS_CLIENT_LABEL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
] as const;

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key];
    if (value != null) out[key] = value;
  }
  return out;
}

/**
 * Every argv this module can build.
 *
 * Exported so the test can enumerate the whole reachable set and assert on it,
 * rather than asserting on the one call the author happened to write a test for.
 * Read the templates: no `--as`, no write verb, and each is a plain array, so
 * there is no string interpolation anywhere that could become syntax.
 */
export const ARGV = Object.freeze({
  follow: (room: string, since: number): readonly string[] => [
    "read",
    "--room",
    room,
    "--since",
    String(since),
    "--follow",
    "--json",
  ],
  history: (room: string): readonly string[] => ["read", "--room", room, "--json"],
  rooms: (): readonly string[] => ["list", "--json"],
  presence: (): readonly string[] => ["presence", "--json"],
  participants: (): readonly string[] => ["participants", "--json"],
});

export type ArgvVerb = keyof typeof ARGV;

/**
 * What kind of failure, so the browser can say *which* one (§5.5 criterion 5).
 *
 * Declared as a plain field and assigned in the constructor rather than as a
 * TypeScript parameter property: the repo runs `node --experimental-strip-types`,
 * whose strip-only mode rejects parameter properties, and the store already
 * avoids them for the same reason.
 */
export type RelayErrorKind = "bad-room" | "bad-since" | "spawn-failed";

export class RelayError extends Error {
  readonly kind: RelayErrorKind;

  constructor(message: string, kind: RelayErrorKind) {
    super(message);
    this.name = "RelayError";
    this.kind = kind;
  }
}

/** A room name the CLI will accept, or a `RelayError` naming why not. */
export function assertRoom(room: unknown): string {
  if (typeof room !== "string" || !isValidRoom(room)) {
    throw new RelayError(
      `${JSON.stringify(room)} is not a valid room name: lowercase letters, digits, dash or ` +
        `underscore, starting with a letter or digit, up to 32 characters.`,
      "bad-room",
    );
  }
  return room;
}

/**
 * The reconnect position: a non-negative decimal integer, passed through.
 *
 * Validated against the written form rather than with `Number`, because
 * `Number("0x10")` is 16 and `Number(" 1e3 ")` is 1000: a cursor that silently
 * accepts a hex literal is a cursor that can be pointed somewhere the reader did
 * not mean. A relay that clamped or defaulted this would be holding the cursor,
 * and holding the cursor is the beginning of a second protocol.
 */
export function assertSince(since: unknown): number {
  if (since == null || since === "") return 0;
  if (typeof since !== "string" && typeof since !== "number") {
    throw new RelayError(`${JSON.stringify(since)} is not a post number.`, "bad-since");
  }
  const written = String(since);
  if (!/^\d+$/.test(written)) {
    throw new RelayError(
      `${JSON.stringify(since)} is not a non-negative whole number of posts.`,
      "bad-since",
    );
  }
  const parsed = Number(written);
  if (!Number.isSafeInteger(parsed)) {
    throw new RelayError(
      `${JSON.stringify(since)} is too large to be a post number.`,
      "bad-since",
    );
  }
  return parsed;
}

export interface RelayExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The child's last stderr, so the browser can name *which* failure it was. */
  stderr: string;
}

export interface FollowRelay {
  /** Complete NDJSON lines, exactly as the child wrote them. */
  onLine(listener: (line: string) => void): void;
  /** Called once, after every line has been delivered. */
  onExit(listener: (exit: RelayExit) => void): void;
  readonly pid: number | undefined;
  stop(): void;
}

/**
 * Spawn `read --follow` and hand back a line stream.
 *
 * `bin/rooms` refuses to stream a room that does not exist and exits 1 with the
 * reason on stderr. That is exactly the error state the browser must be able to
 * tell apart from an empty room, so stderr is retained (bounded) and forwarded.
 * stdout is treated as opaque: the relay does not parse, renumber or filter the
 * objects, because §4 and §5.4 make a reader that resequences a reader that
 * invents history.
 */
export function followRoom(
  room: unknown,
  sinceRaw: unknown,
  options: { bin?: string; env?: NodeJS.ProcessEnv } = {},
): FollowRelay {
  const validRoom = assertRoom(room);
  const since = assertSince(sinceRaw);
  const bin = options.bin ?? ROOMS_BIN;

  // stdin is `ignore` on purpose: the relay has nothing to say to the writer,
  // and a pipe it never writes would only be a handle to leak.
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [bin, ...ARGV.follow(validRoom, since)],
    {
      // The caller's environment, not this module's. The server is started with
      // an explicit `PI_ROOMS_DIR` in tests and by `--` in production; a child
      // that read `process.env` instead would stream whichever store the
      // *server* happened to inherit, which is a silent wrong-store bug: history
      // loads from one place and the live stream watches another.
      env: options.env ?? childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Not a shell. The room name is a separate argv element above and cannot
      // become syntax whatever it contains; the validator is defence in depth,
      // not the mechanism.
      shell: false,
    },
  );

  const lineListeners: Array<(line: string) => void> = [];
  const exitListeners: Array<(exit: RelayExit) => void> = [];
  let pending = "";
  let stderr = "";
  let exited = false;
  /** The stream can run for hours; only the tail of stderr can name a failure. */
  const STDERR_CAP = 4096;

  const emitLine = (line: string) => {
    if (line.length === 0) return;
    for (const listener of lineListeners) listener(line);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index !== -1) {
      // `\r` could only appear under a different line-ending convention;
      // stripping it keeps the frame valid JSON without touching the object.
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      emitLine(line);
      index = pending.indexOf("\n");
    }
  });

  // A final line with no trailing newline is still a complete object. The CLI
  // always writes one, so this only matters if that ever changes.
  child.stdout.on("end", () => {
    if (pending.length > 0) {
      emitLine(pending.replace(/\r$/, ""));
      pending = "";
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_CAP);
  });

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    const exit: RelayExit = { code, signal, stderr: stderr.trim() };
    for (const listener of exitListeners) listener(exit);
  };

  child.on("error", (error) => {
    stderr = `${stderr}\n${error.message}`.trim();
    finish(null, null);
  });
  // `close` fires after stdio has drained, which is what guarantees the browser
  // sees every line before it sees the exit. `exit` would race the pipes.
  child.on("close", (code, signal) => finish(code, signal));

  return {
    onLine(listener) {
      lineListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    pid: child.pid,
    stop() {
      // SIGTERM is handled by the child's own `stop()`, which prints
      // "stopped following" and exits 0. Signalling the pid we were handed is
      // selective by construction: there is no pattern here, so it cannot reach
      // a sibling lane or the shell that started this server.
      if (!exited) child.kill("SIGTERM");
    },
  };
}

/**
 * Run a read-only verb to completion and parse its JSON.
 *
 * Used for the snapshot reads and for room history. All three are read-only
 * *without* `--as`: `writeLease` no-ops on a null identity, so no presence file
 * and no receipt is touched — which is why the allow-list above has no `--as` in
 * it and why this function cannot be pointed at a write.
 *
 * A non-zero exit is reported with its stderr instead of an empty result,
 * because criterion 5's "a blank pane is indistinguishable from an empty room"
 * is precisely what swallowing it would produce.
 */
export async function readJsonVerb(
  verb: ArgvVerb,
  args: readonly unknown[] = [],
  options: { bin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  const bin = options.bin ?? ROOMS_BIN;
  const build = ARGV[verb] as (...a: unknown[]) => readonly string[];
  const argv = build(...args);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv], {
      env: options.env ?? childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new RelayError(`${argv[0]} did not finish within ${timeoutMs}ms.`, "spawn-failed"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RelayError(`could not start ${bin}: ${error.message}`, "spawn-failed"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new RelayError(
            `${argv[0]} exited ${code}: ${stderr.trim() || "(no stderr)"}`,
            "spawn-failed",
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new RelayError(`${argv[0]} printed something that is not JSON.`, "spawn-failed"));
      }
    });
  });
}
