/**
 * A minimal Chrome DevTools Protocol driver.
 *
 * The repo has no browser dependency and this task should not add one: the
 * client is vendored Solid with no build pipeline, so a 3MB test-only
 * `playwright` install would be the heaviest thing in the package. Node 22 ships
 * a global `WebSocket`, and CDP is JSON over one, so the whole driver is
 * `evaluate`, `screenshot`, and the launch/teardown around them.
 *
 * It is used by two things:
 *
 *  - `web/test/browser.test.ts`, which proves the motion rules against a real
 *    rendering engine rather than against a regex over CSS.
 *  - `web/tools/screenshot.ts`, which produces the artifact the operator opens
 *    for `G4`.
 *
 * Scope, stated so nobody mistakes it for a general harness: one page, one
 * session, no test isolation, no retries. If this grows three more features it
 * should become playwright rather than become a worse browser.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Chrome's binary, resolved from the usual names. Fails loudly rather than silently. */
export function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((c): c is string => c != null && c.length > 0);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    `no Chrome found. Looked at:\n  ${candidates.join("\n  ")}\nSet CHROME_PATH to a browser binary.`,
  );
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** One CDP message, in the flat shape the protocol actually uses. */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

export interface Browser {
  /** Evaluate an expression in the page and return its JSON value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Wait until `expression` is truthy, or throw after `timeoutMs`. */
  waitFor(expression: string, options?: { timeoutMs?: number; label?: string }): Promise<void>;
  /** A PNG of the viewport (or the full page when `fullPage`). */
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  /** Emulate a media feature, e.g. `prefers-reduced-motion: reduce`. */
  setMedia(options: { reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" }): Promise<void>;
  /** The browser console, for diagnosing a blank page. */
  readonly logs: string[];
  /** Console errors and page exceptions seen so far. */
  readonly errors: string[];
  goto(url: string): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  /**
   * Run `source` in every document before its own scripts.
   *
   * Returns an id so the script can be removed again. CDP keeps these for the
   * life of the page's session, so a script left installed keeps firing on every
   * later navigation — which is how a "hold the history fetch open" helper
   * silently froze every screenshot taken after it.
   */
  initScript(source: string): Promise<string>;
  /** Remove a script installed by {@link initScript}. */
  removeInitScript(identifier: string): Promise<void>;
  close(): Promise<void>;
}

class CdpError extends Error {}

/** Launch Chrome and attach to a fresh page. */
export async function launchBrowser(
  options: { headless?: boolean; width?: number; height?: number; deviceScaleFactor?: number } = {},
): Promise<Browser> {
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-cdp-"));
  const port = await freePort();
  const args = [
    options.headless === false ? "" : "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${options.width ?? 1280},${options.height ?? 900}`,
    "about:blank",
  ].filter((a) => a.length > 0);

  const child: ChildProcess = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const wsUrl = await waitForDebugger(port, () => stderr, child);

  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new CdpError(`could not open ${wsUrl}`)), { once: true });
  });

  const logs: string[] = [];
  const errors: string[] = [];
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error != null) entry.reject(new CdpError(`${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const params = message.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      logs.push(`[${params.type ?? "log"}] ${text}`);
      if (params.type === "error") errors.push(text);
    } else if (message.method === "Runtime.exceptionThrown") {
      const params = message.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      const text = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception";
      errors.push(text);
    }
  });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");

  const width = options.width ?? 1280;
  const height = options.height ?? 900;

  const browser: Browser = {
    logs,
    errors,
    async goto(url) {
      // A fresh document per navigation, so a test cannot inherit the previous
      // page's signals.
      await send("Page.navigate", { url });
      await waitForLoad(send);
    },
    async setViewport(w, h) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: options.deviceScaleFactor ?? 2,
        mobile: false,
      });
    },
    async evaluate<T>(expression: string): Promise<T> {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: false,
      });
      const exception = result.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
      if (exception != null) {
        throw new CdpError(exception.exception?.description ?? exception.text ?? "evaluate threw");
      }
      return (result.result as { value?: T } | undefined)?.value as T;
    },
    async waitFor(expression, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown = null;
      while (Date.now() < deadline) {
        try {
          if (await browser.evaluate<boolean>(`Boolean(${expression})`)) return;
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const detail = lastError == null ? "" : `\n  last error: ${(lastError as Error).message}`;
      throw new CdpError(
        `${opts.label ?? expression} did not become true within ${timeoutMs}ms.` +
          `\n  page errors: ${errors.join(" | ") || "(none)"}` +
          `\n  console: ${logs.slice(-6).join(" | ") || "(none)"}${detail}`,
      );
    },
    async screenshot(opts = {}) {
      const params: Record<string, unknown> = { format: "png", captureBeyondViewport: opts.fullPage === true };
      if (opts.fullPage === true) {
        const metrics = await send("Page.getLayoutMetrics");
        const content = metrics.cssContentSize as { width: number; height: number };
        params.clip = { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height), scale: 1 };
      }
      const result = await send("Page.captureScreenshot", params);
      return Buffer.from(String(result.data), "base64");
    },
    async initScript(source) {
      const result = await send("Page.addScriptToEvaluateOnNewDocument", { source });
      return String((result as { identifier?: string }).identifier ?? "");
    },
    async removeInitScript(identifier) {
      if (identifier.length === 0) return;
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    },
    async setMedia(opts) {
      await send("Emulation.setEmulatedMedia", {
        features: [
          ...(opts.reducedMotion != null
            ? [{ name: "prefers-reduced-motion", value: opts.reducedMotion }]
            : []),
          ...(opts.colorScheme != null ? [{ name: "prefers-color-scheme", value: opts.colorScheme }] : []),
        ],
      });
    },
    async close() {
      try {
        await send("Browser.close");
      } catch {
        /* the browser may already be gone */
      }
      socket.close();
      child.kill("SIGKILL");

      // Wait for the process to actually be gone before touching its profile.
      // SIGKILL returns immediately, but Chrome's child processes keep writing
      // into the user-data-dir for a moment afterwards, and `rmSync` on a
      // directory that is still being written throws ENOTEMPTY. That threw from
      // teardown and failed the *last test in the file* — a cleanup bug reported
      // as a product bug, which is the most expensive kind of false signal.
      await waitForExit(child, 5_000);

      // And even then, be forgiving: a profile directory that cannot be removed
      // is litter in /tmp, never a reason to fail an assertion. Retry a few
      // times and then leave it; the OS reclaims temp files.
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best effort: a stale temp dir is not a test failure */
      }
    },
  };

  await browser.setViewport(width, height);
  return browser;
}

/**
 * Resolve when `child` has exited, or after `timeoutMs`.
 *
 * Teardown needs this: `kill()` only delivers a signal, and the directory the
 * child wrote is still busy for a moment after it is signalled.
 */
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForLoad(send: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  // `Page.loadEventFired` is an event, not a response, so poll the document
  // readiness instead — simpler and good enough for a localhost page.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if ((state.result as { value?: string } | undefined)?.value === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new CdpError("page did not finish loading");
}

async function waitForDebugger(port: number, stderr: () => string, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new CdpError(`chrome exited ${child.exitCode} before the debugger was ready:\n${stderr()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()) as CdpTarget[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl != null);
      if (page?.webSocketDebuggerUrl != null) return page.webSocketDebuggerUrl;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new CdpError(
    `chrome's debugger did not come up on ${port}. ${lastError == null ? "" : String(lastError)}\n${stderr()}`,
  );
}

/** An ephemeral port, so two test files running at once cannot collide. */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address != null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
