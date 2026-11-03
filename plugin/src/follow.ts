/**
 * The one long-lived child: `rooms read --follow`.
 *
 * There is no herdr event for "a file under `$HOME` changed", so polling the
 * store from the plugin would be the wrong shape: the CLI already owns the poll
 * loop, the gap detection, the sequence arithmetic and the message cap. This
 * module holds one follower for one room and does nothing clever with its
 * output.
 *
 * Lifecycle rules, each from a documented failure:
 *
 *   **A closed reader is normal.** The follower exits 0 on EPIPE, but only when
 *   it next has something to write — so a popup that closes must *kill* the
 *   child rather than wait to be told. `kill()` is explicit, idempotent, and
 *   escalates to SIGKILL if SIGTERM is ignored.
 *
 *   **A child of the pane is not a daemon.** `detached` is false and the process
 *   is killed from an `exit` hook, so closing the popup cannot leak a follower.
 *
 *   **A dead follower is a named failure, not a blank pane.** The exit code and
 *   the last stderr lines are kept so the renderer can say *what* died.
 *
 * `--as` is deliberately never passed. A read is not a write, and passing a
 * participant name would make the CLI refresh that human's presence lease —
 * a write, from a reader. The consequence is real and is reported rather than
 * papered over: a human sitting in the popup does not look `online` while they
 * sit there, because declaring presence is the writer's job, not the viewer's.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `<repo>/bin/rooms`, from `<repo>/plugin/src/follow.ts`. */
export const ROOMS_BIN = path.resolve(HERE, "..", "..", "bin", "rooms");

export interface FollowOptions {
  room: string;
  /** Resume from this post number. 0 starts at the beginning of the log. */
  since: number;
  env: NodeJS.ProcessEnv;
  onEvent: (event: Record<string, unknown>, raw: string) => void;
  onExit: (outcome: FollowOutcome) => void;
  /** Called once the child has been alive for a moment with no output. */
  onQuiet?: () => void;
  /** How long a silent child gets before it is considered up. */
  quietMs?: number;
}

export interface FollowOutcome {
  /** True when this module killed it on purpose, which is not an error. */
  stopped: boolean;
  code: number | null;
  signal: string | null;
  /** The last lines the follower wrote to stderr, for a failure's cause text. */
  diagnostics: string[];
  /** Non-null when the follower failed in a way the reader should see named. */
  failure: { title: string; cause: string } | null;
}

export class Follower {
  private readonly options: FollowOptions;
  private child: ChildProcess | null = null;
  private buffer = "";
  private diagnostics: string[] = [];
  private stopped = false;
  private quietTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private exitHook: (() => void) | null = null;

  constructor(options: FollowOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.child != null && this.child.exitCode == null && this.child.signalCode == null;
  }

  start(): void {
    if (this.child != null) this.stop();
    const args = [
      ROOMS_BIN,
      "read",
      "--room",
      this.options.room,
      "--follow",
      "--since",
      String(Math.max(0, this.options.since)),
    ];
    this.child = spawn(process.execPath, args, {
      env: this.options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.exitHook = () => {
      // Synchronous last resort: an `exit` handler cannot await, so the child is
      // signalled directly. This is what stops a popped-out popup leaking a
      // follower that keeps polling a log nobody is reading.
      try {
        this.child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    process.once("exit", this.exitHook);

    this.child.on("error", (error) => {
      this.finish({ failure: { title: "the follower could not start", cause: error.message } });
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.consume(chunk));

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length === 0) continue;
        this.diagnostics.push(line.trim());
        if (this.diagnostics.length > 8) this.diagnostics.shift();
      }
    });

    this.child.on("exit", (code, signal) => {
      if (this.stopped) {
        this.finish({ stopped: true });
        return;
      }
      const detail = this.diagnostics.at(-1);
      const failure =
        code === 0
          ? {
              title: "the follower stopped",
              cause: `it exited 0 on its own${detail != null ? `: ${detail}` : ""} · press r to restart it`,
            }
          : {
              title: "the follower failed",
              cause: `exit ${code ?? signal}${detail != null ? `: ${detail}` : ""} · press r to restart it`,
            };
      this.finish({ code, signal, failure });
    });

    const quietMs = this.options.quietMs ?? 400;
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.options.onQuiet?.();
    }, quietMs);
    this.quietTimer.unref?.();
  }

  /** Stop the child and do not report it as a failure. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.quietTimer != null) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    const child = this.child;
    if (child == null || child.exitCode != null) {
      this.finish({ stopped: true });
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      try {
        if (child.exitCode == null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 1500);
    this.killTimer.unref?.();
  }

  private finish(partial: Partial<FollowOutcome> & { stopped?: boolean }): void {
    if (this.quietTimer != null) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.killTimer != null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (this.exitHook != null) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = null;
    }
    const outcome: FollowOutcome = {
      stopped: partial.stopped === true,
      code: partial.code ?? null,
      signal: partial.signal ?? null,
      diagnostics: [...this.diagnostics],
      failure: partial.failure ?? null,
    };
    this.child = null;
    this.options.onExit(outcome);
  }

  /**
   * NDJSON in, events out.
   *
   * A line that does not parse is reported as a named failure rather than
   * dropped: a follower writing non-JSON is a version skew the reader must see,
   * and silently skipping it would hide every later line too.
   */
  private consume(chunk: string): void {
    if (this.quietTimer != null) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
      this.options.onQuiet?.();
    }
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        this.options.onEvent(parsed, line);
      } catch (error) {
        this.options.onEvent(
          {
            ok: false,
            type: "unparseable",
            error: `the follower wrote a line that is not JSON: ${(error as Error).message}`,
            line: line.slice(0, 200),
          },
          line,
        );
      }
    }
  }
}

/** Parse the follower's argv-pure invocation for a test, without spawning. */
export function followArgs(room: string, since: number): string[] {
  return [ROOMS_BIN, "read", "--room", room, "--follow", "--since", String(Math.max(0, since))];
}
