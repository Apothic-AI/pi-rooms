/**
 * The terminal loop.
 *
 * A popup gets a real PTY, `TERM=xterm-256color`, raw mode and the whole
 * keyboard including Escape, so this is a plain alternate-screen renderer:
 * read keys, mutate state, repaint.
 *
 * Repaint rules, and why:
 *
 *   **Diffed, not cleared.** A full clear on every frame makes a terminal
 *   flicker and, worse, makes an arrival animation indistinguishable from a
 *   redraw. Only lines that changed are rewritten.
 *
 *   **One timer, and only when there is motion.** The ticker runs while an
 *   arrival is animating and stops when it is done, so an idle popup burns no
 *   CPU. Under `NO_MOTION` / `REDUCED_MOTION` / `TERM=dumb` the timer never
 *   starts.
 *
 *   **Every exit path restores the screen.** `finally`, plus an `exit` hook:
 *   an exception, a quit key or a signal all leave the terminal usable.
 */

import { motionEnabled } from "./theme.ts";
import { render, renderHelp, type RenderOpts } from "./render.ts";
import {
  ackTarget,
  applyFollowEvent,
  applySnapshot,
  failStream,
  initialSnapshotFor,
  markLive,
  moveSelection,
  scrollBy,
  selectedEntry,
  setNotice,
  type State,
} from "./model.ts";
import { Follower } from "./follow.ts";
import { requestAck } from "./ack.ts";
import { readSnapshot } from "./reader.ts";

const ESC = "\u001b";
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J`;
const HOME = `${ESC}[H`;

export interface RunOptions {
  identity: string | null;
  env: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** For tests: how many frames to paint before returning. */
  frames?: number;
}

export class App {
  state: State;
  private readonly options: RunOptions;
  private readonly out: NodeJS.WriteStream;
  private readonly onExit: () => void;
  private follower: Follower | null = null;
  private timer: NodeJS.Timeout | null = null;
  private previous: string[] = [];
  private closed = false;
  private motion: boolean;

  constructor(options: RunOptions, out: NodeJS.WriteStream, onExit: () => void) {
    this.options = options;
    this.out = out;
    this.onExit = onExit;
    this.motion = motionEnabled(options.env);
    this.state = initialSnapshotFor(options.identity, readSnapshot(options.env, options.identity));
  }

  get width(): number {
    return this.out.columns ?? 100;
  }

  get height(): number {
    return this.out.rows ?? 32;
  }

  /** Start whatever the current selection needs. Called once, and on every switch. */
  sync(): void {
    const entry = selectedEntry(this.state);
    if (entry.kind !== "room") {
      this.stopFollower();
      // The inbox and humans views are pure functions of the snapshot, which
      // `applySnapshot` has already rebuilt.
      this.repaint();
      return;
    }
    this.stopFollower();
    this.state = { ...this.state, stream: emptyStreamFor() };
    const follower = new Follower({
      room: entry.key,
      since: 0,
      env: this.options.env,
      onEvent: (event) => {
        this.state = applyFollowEvent(this.state, event, Date.now(), this.state.identity);
        this.repaint();
      },
      onExit: (outcome) => {
        if (outcome.stopped) {
          this.repaint();
          return;
        }
        const failure = outcome.failure ?? {
          title: "the follower stopped",
          cause: "no cause recorded",
        };
        this.state = failStream(this.state, failure.title, failure.cause, Date.now());
        this.repaint();
      },
      onQuiet: () => {
        this.state = markLive(this.state);
        this.repaint();
      },
    });
    this.follower = follower;
    follower.start();
    this.repaint();
  }

  private stopFollower(): void {
    const follower = this.follower;
    this.follower = null;
    follower?.stop();
  }

  refresh(now = Date.now()): void {
    this.state = applySnapshot(
      this.state,
      readSnapshot(this.options.env, this.state.identity, now),
      now,
    );
    this.repaint();
  }

  repaint(now = Date.now()): void {
    if (this.closed) return;
    const opts: RenderOpts = {
      cols: this.width,
      rows: this.height,
      now,
      motion: this.motion,
      tick: Math.floor(now / 60),
    };
    const lines = this.state.help ? renderHelp(this.state, opts) : render(this.state, opts);
    this.paint(lines);
    this.scheduleTick(now);
  }

  private scheduleTick(now: number): void {
    if (!this.motion) return;
    const animating = this.state.stream.rows.some(
      (row) => row.arrivedAt != null && now - row.arrivedAt < 300,
    );
    if (!animating) {
      if (this.timer != null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    if (this.timer != null) return;
    this.timer = setInterval(() => {
      this.repaint(Date.now());
    }, 60);
    this.timer.unref?.();
  }

  /** Write only the lines that differ, so a steady screen does not flicker. */
  private paint(lines: string[]): void {
    let buffer = HOME;
    for (let i = 0; i < lines.length; i += 1) {
      if (this.previous[i] === lines[i]) {
        buffer += `${ESC}[1B`;
        continue;
      }
      buffer += `${ESC}[${i + 1};1H${ESC}[2K${lines[i]}`;
    }
    this.previous = lines;
    this.out.write(buffer);
  }

  handleKey(key: string): boolean {
    if (this.state.pendingAck != null) {
      const answer = key.toLowerCase();
      if (answer === "y") {
        const id = this.state.pendingAck;
        this.state = { ...this.state, pendingAck: null };
        this.repaint();
        this.runAck(id);
        return false;
      }
      if (answer === "n" || key === "\u001b") {
        this.state = { ...this.state, pendingAck: null, notice: null };
        this.repaint();
        return false;
      }
      return false;
    }

    switch (key) {
      case "q":
      case "\u0003":
      case "\u001b":
        this.exit();
        return true;
      case "\u000e": // ctrl-n
      case "\u001b[B":
        this.state = moveSelection(this.state, 1);
        this.sync();
        return false;
      case "\u0010": // ctrl-p
      case "\u001b[A":
        this.state = moveSelection(this.state, -1);
        this.sync();
        return false;
      case "\u0004": // ctrl-d
        this.state = scrollBy(this.state, 4);
        this.repaint();
        return false;
      case "\u0015": // ctrl-u
        this.state = scrollBy(this.state, -4);
        this.repaint();
        return false;
      case "r":
        this.stopFollower();
        this.state = { ...this.state, notice: null, stream: emptyStreamFor() };
        this.refresh();
        this.sync();
        return false;
      case "?":
        this.state = { ...this.state, help: !this.state.help };
        this.previous = [];
        this.repaint();
        return false;
      case "a": {
        const target = ackTarget(this.state);
        if (target == null) {
          this.state = setNotice(
            this.state,
            "info",
            selectedEntry(this.state).kind !== "inbox"
              ? "ack works on the inbox: press ↑ to select it first"
              : "no message is waiting for an ack",
          );
          this.repaint();
          return false;
        }
        this.state = { ...this.state, pendingAck: target, notice: null };
        this.repaint();
        return false;
      }
      default:
        return false;
    }
  }

  private runAck(id: string): void {
    const identity = this.state.identity;
    if (identity == null) {
      this.state = setNotice(this.state, "error", "no name, so there is no receipt this client may stamp");
      this.repaint();
      return;
    }
    requestAck({
      identity,
      id,
      env: this.options.env,
      onDone: (outcome) => {
        this.state = setNotice(
          this.state,
          outcome.ok ? "info" : "error",
          outcome.message,
        );
        this.refresh();
      },
    });
  }

  exit(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopFollower();
    this.out.write(`${CURSOR_SHOW}${ALT_OFF}`);
    this.onExit();
  }
}

function emptyStreamFor() {
  return { status: "loading" as const, rows: [], cursor: 0, errorTitle: null, errorCause: null, loading: true };
}

/** Run the popup until quit. Resolves when the terminal is restored. */
export function run(options: RunOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const out = stdout;
  return new Promise<void>((resolve) => {
    let app: App | null = null;
    const restore = () => {
      try {
        if (stdin.isTTY) stdin.setRawMode(false);
      } catch {
        /* not a tty */
      }
      out.write(`${CURSOR_SHOW}${ALT_OFF}`);
    };
    const onExitHook = () => restore();
    process.once("exit", onExitHook);

    app = new App(options, stdout, () => {
      resolve();
    });

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      // Escape sequences arrive as one read in practice; a lone ESC is a quit.
      const keys = tokenizeKeys(text);
      for (const key of keys) {
        if (app == null) break;
        if (app.handleKey(key)) break;
      }
    };

    const cleanup = () => {
      stdin.off("data", onData);
      process.removeListener("exit", onExitHook);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGHUP", onSigterm);
      // A resumed stdin is a live handle: without this the process stays up
      // forever after the screen is restored. That is not cosmetic — a popup
      // that ignores SIGTERM is a leaked process holding a popup slot, and the
      // next open then fails with `a popup pane is already open`.
      try {
        stdin.pause();
      } catch {
        /* already gone */
      }
      stdin.unref?.();
      restore();
      resolve();
    };
    /**
     * Restore, then leave for real.
     *
     * Registering any signal handler replaces Node's default terminate, so the
     * handler owes an explicit exit. `restore()` is a small synchronous write to
     * a TTY, and the deferred exit gives it a turn to land before the process
     * goes away, so the alternate screen is always left in a usable state.
     */
    const shutdown = () => {
      const exiting = app;
      app = null;
      exiting?.exit();
      cleanup();
      process.exitCode = 0;
      setImmediate(() => process.exit(0));
    };
    const onSigterm = () => shutdown();
    const onSigint = () => shutdown();

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
    process.on("SIGHUP", onSigterm);

    stdout.write(`${ALT_ON}${CURSOR_HIDE}${CLEAR}${HOME}`);
    app.sync();
    const originalExit = app.exit.bind(app);
    app.exit = () => {
      originalExit();
      cleanup();
      // The quit key has no signal to do this for it. Without it the resumed
      // stdin keeps the loop alive and `q` leaves a process behind.
      setImmediate(() => process.exit(0));
    };
  });
}

/** Split a raw read into keys. Arrows and ctrl chords each become one token. */
export function tokenizeKeys(text: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ESC && text[i + 1] === "[") {
      const tail = text.slice(i, i + 3);
      if (/^\u001b\[[ABCD]/.test(tail)) {
        keys.push(tail.slice(0, 3));
        i += 2;
        continue;
      }
      keys.push(ESC);
      continue;
    }
    keys.push(text[i]!);
  }
  return keys;
}
