/**
 * The ack shell-out.
 *
 * `readAt` means *a screen showed these bytes*. Only `rooms ack` writes it, and
 * only on an explicit keypress — a renderer that stamped it on paint would have
 * manufactured the one piece of evidence this whole run exists to protect.
 *
 * So the plugin never touches a receipt. It runs the CLI, and reports what the
 * CLI said. Two consequences worth stating:
 *
 *   **No `--json`.** The human-facing output is the thing an operator may want
 *   to read, and the exit code is the contract.
 *
 *   **It is not retried.** An ack that failed because the lock was held or the id
 *   was not this name's mail is reported as a failure. Retrying would turn "this
 *   did not happen" into "this happened eventually", which is a different claim.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { ROOMS_BIN } from "./follow.ts";

export interface AckOptions {
  identity: string;
  id: string;
  env: NodeJS.ProcessEnv;
  onDone: (outcome: AckOutcome) => void;
}

export interface AckOutcome {
  ok: boolean;
  code: number | null;
  /** One line for the footer: what happened, in the CLI's own words. */
  message: string;
  stdout: string;
  stderr: string;
}

export const ACK_TIMEOUT_MS = 10_000;

/**
 * Run `rooms ack --id ID --as NAME`.
 *
 * `--as` is passed here, unlike in the follower, because this *is* a write: the
 * receipt is keyed by recipient and the CLI refuses to stamp anyone else's. Note
 * that it also refreshes that name's presence lease, which is honest — the human
 * is at the keyboard, and this invocation is the heartbeat.
 */
export function requestAck(options: AckOptions): ChildProcess {
  const args = [ROOMS_BIN, "ack", "--id", options.id, "--as", options.identity];
  const started = Date.now();
  const child = spawn(process.execPath, args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    options.onDone({
      ok: false,
      code: null,
      message: `ack did not finish within ${Math.round(ACK_TIMEOUT_MS / 1000)}s and was killed — the message is still unacked`,
      stdout,
      stderr,
    });
  }, ACK_TIMEOUT_MS);
  timer.unref?.();

  child.on("error", (error) => {
    clearTimeout(timer);
    options.onDone({
      ok: false,
      code: null,
      message: `ack could not start: ${error.message}`,
      stdout,
      stderr,
    });
  });

  child.on("exit", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      options.onDone({
        ok: true,
        code,
        message: `readAt written for ${options.id.slice(0, 8)}${describeElapsed(Date.now() - started)}`,
        stdout,
        stderr,
      });
      return;
    }
    const detail = (stderr.trim().split("\n").at(-1) ?? "").replace(/^rooms:\s*/, "");
    options.onDone({
      ok: false,
      code,
      message: `ack refused${detail.length > 0 ? `: ${detail}` : ` (exit ${code})`} — nothing was written`,
      stdout,
      stderr,
    });
  });

  return child;
}

function describeElapsed(ms: number): string {
  return ms < 1000 ? "" : ` in ${ms}ms`;
}
