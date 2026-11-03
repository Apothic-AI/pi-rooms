/**
 * Produce the artifact `G4` is actually about: pictures of the running client.
 *
 * `G4`'s owner is the operator and its question is "is this stunning", which no
 * test can answer. So this tool's job is narrow and mechanical: start the real
 * server against a real demo store, drive a real browser, and write PNGs that a
 * reader can look at without rebuilding anything.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings web/tools/screenshot.ts --out DIR
 *
 * Everything it touches is a temp store. It never reads or writes
 * `~/.pi/agent/rooms`, and the only write it performs is one deliberate
 * `bin/rooms post` **into that temp store**, made to prove that a live arrival
 * reaches the browser — the same write a human would type in a terminal.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildDemoStore, OPERATOR, ROOM, TOKEN } from "./demo-store.ts";
import { launchBrowser } from "./cdp.ts";
import { startWebServer } from "../server/server.ts";
import { resolvePaths, createRoom, saveRoom } from "../../src/store.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BIN = path.join(ROOT, "bin", "rooms");

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] != null) return args[index + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline != null) return inline.slice(name.length + 3);
  return fallback;
}

const OUT_DIR = path.resolve(arg("out", path.join(ROOT, "web", "screenshots")));
const WIDTH = Number(arg("width", "1440"));
const HEIGHT = Number(arg("height", "940"));

/**
 * A store whose *listed* room cannot be read, so the error state is produced by
 * the real writer's real stderr rather than by a mock.
 *
 * The trick is a room directory whose `room.json` declares a different name:
 * `list` enumerates directory entries and reports the name inside the file, so
 * the rail shows a room that `read --room <that name>` cannot open. That is a
 * genuine corrupt-store case, and the point of the screenshot is precisely that
 * a reader is told *which* failure instead of being shown a blank pane.
 */
function buildUnreadableRoomStore(base: string) {
  const store = buildDemoStore(base);
  const paths = resolvePaths(base);
  const brokenDir = path.join(paths.rooms, "unreadable");
  fs.mkdirSync(brokenDir, { recursive: true });
  // `room.json` claims a name, but the directory is not that name, so the read
  // path resolves a file that is not there.
  saveRoom(paths, { name: "unreadable-room", members: [OPERATOR], createdBy: OPERATOR, createdAt: new Date().toISOString() });
  createRoom(paths, { name: "unreadable-room", members: [OPERATOR], createdBy: OPERATOR, createdAt: new Date().toISOString() });
  // Move the saved file so `rooms/unreadable-room` does not exist, leaving the
  // listing entry pointing at a name with no directory.
  const realDir = path.join(paths.rooms, "unreadable-room");
  fs.renameSync(realDir, brokenDir);
  return store;
}

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

async function postFromTerminal(base: string, room: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, "post", "--room", room, "--as", OPERATOR, "--token", TOKEN, text],
      { env: { ...process.env, PI_ROOMS_DIR: base }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rooms post exited ${code}: ${stderr}`));
    });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const demo = buildDemoStore();
  const broken = buildUnreadableRoomStore(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pi-rooms-broken-")));
  const env = { ...process.env, PI_ROOMS_DIR: demo.base };

  const server = await startWebServer({ port: 0, me: OPERATOR, env, silent: true });
  const brokenEnv = { ...process.env, PI_ROOMS_DIR: broken.base };
  const brokenServer = await startWebServer({ port: 0, me: OPERATOR, env: brokenEnv, silent: true });

  const browser = await launchBrowser({ width: WIDTH, height: HEIGHT });
  const written: string[] = [];

  const shot = async (name: string, options: { fullPage?: boolean } = {}) => {
    const buffer = await browser.screenshot(options);
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, buffer);
    written.push(file);
    log(`  ${path.relative(process.cwd(), file)}  (${(buffer.length / 1024).toFixed(0)} kB)`);
    return file;
  };

  try {
    log(`demo store:  ${demo.base}`);
    log(`reader:      ${server.url}`);
    log(`screenshots: ${OUT_DIR}`);

    // ── 1 & 2: the room, in both grounds ────────────────────────────────────
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.row').length >= 5`, { label: "five history rows" });
    await browser.waitFor(`document.querySelectorAll('.receipt').length > 0`, { label: "receipt ladders" });
    // Let the web fonts settle and the last history row's border paint.
    await browser.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await shot("01-room-light.png");
    await shot("02-room-light-full.png", { fullPage: true });

    await browser.setMedia({ colorScheme: "dark" });
    await shot("03-room-dark.png");
    await browser.setMedia({ colorScheme: "light" });

    // ── 4: a live arrival, caught in flight ─────────────────────────────────
    // The write is a real `bin/rooms post` into the *temp* store — the same
    // command a human runs in a terminal. It proves the SSE relay delivers an
    // arrival to the browser, which no static screenshot could show.
    const before = await browser.evaluate<number>("document.querySelectorAll('.row').length");
    await postFromTerminal(
      demo.base,
      ROOM,
      "This line was typed in a terminal after the page was already open. It should have arrived on its own — no reload, and the rows above it should not have moved or re-animated.",
    );
    await browser.waitFor(`document.querySelectorAll('.row').length > ${before}`, {
      label: "the live post to arrive over SSE",
      timeoutMs: 15_000,
    });
    // Scroll the new row into view *before* capturing: a screenshot of the
    // arrival taken with the row below the fold would be a picture of the old
    // rows, which is the opposite of what this artifact is for. `scrollIntoView`
    // with `block: 'end'` puts it at the bottom edge, where a new message
    // actually appears.
    await browser.evaluate(`
      (() => {
        const rows = document.querySelectorAll('.row');
        rows[rows.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' });
        return true;
      })()
    `);
    // The arrival wash + translate is 260ms; capture while it is still running.
    await shot("04-arrival-midflight.png");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await shot("05-arrival-settled.png");

    // ── 6: reduced motion ───────────────────────────────────────────────────
    await browser.setMedia({ reducedMotion: "reduce" });
    const animation = await browser.evaluate<string | null>(
      `getComputedStyle(document.querySelector('.row--arrive') ?? document.body).animationName`,
    );
    log(`  reduced-motion animation-name on the newest row: ${animation}`);
    await shot("06-reduced-motion.png");
    await browser.setMedia({ reducedMotion: "no-preference" });

    // ── 7: the DM inbox ─────────────────────────────────────────────────────
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('inbox'))?.click()`,
    );
    await browser.waitFor(`document.querySelector('.tag--dm') != null`, { label: "the inbox view" });
    await browser.waitFor(`document.querySelectorAll('.row').length >= 2`, { label: "two DMs" });
    await shot("07-inbox.png");

    // ── 8: an empty room ────────────────────────────────────────────────────
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('web-client'))?.click()`,
    );
    await browser.waitFor(`document.querySelector('.state--empty') != null`, { label: "the empty state" });
    await shot("08-empty-room.png");

    // ── 9: the error state, from a real failing writer ──────────────────────
    await browser.goto(brokenServer.url);
    // Wait for the *room* button, not for any `.rail__item`: the inbox entry is
    // rendered before `/api/rooms` answers, so waiting on the generic selector
    // wins the race and the click silently finds nothing.
    await browser.waitFor(
      `[...document.querySelectorAll('.rail__item')].some((b) => b.textContent.includes('unreadable-room'))`,
      { label: "the broken store's room list" },
    );
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('unreadable-room')).click()`,
    );
    await browser.waitFor(`document.querySelector('.state--error') != null`, { label: "the error state" });
    const errorText = await browser.evaluate<string>("document.querySelector('.state--error')?.innerText ?? ''");
    log(`  error state says: ${JSON.stringify(errorText.slice(0, 160))}`);
    await shot("09-error.png");

    // ── 10: the loading state ───────────────────────────────────────────────
    // A read that is genuinely slow: `fetch` is held open for the room-history
    // call, so the skeletons are a real frame of the real client rather than a
    // re-implementation of what one might look like. Only the history GET is
    // delayed; config, roster and the stream are untouched, so the shell around
    // the skeletons is the real shell.
    const holdHistory = await browser.initScript(`
      (() => {
        const realFetch = window.fetch.bind(window);
        window.__releaseHistory = null;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (/\\/api\\/rooms\\/[^/?]+$/.test(url)) {
            return new Promise((resolve) => {
              window.__releaseHistory = () => resolve(realFetch(input, init));
            });
          }
          return realFetch(input, init);
        };
      })();
    `);
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelector('.skeleton') != null`, { label: "the loading skeletons" });
    await shot("10-loading.png");
    // Release the held response so the page finishes normally.
    await browser.evaluate(`window.__releaseHistory ? (window.__releaseHistory(), true) : false`);
    await browser.waitFor(`document.querySelector('.skeleton') == null`, { label: "loading to finish" });
    // Remove the hold, or every later navigation inherits it and freezes.
    await browser.removeInitScript(holdHistory);

    // ── 11: narrow viewport ─────────────────────────────────────────────────
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.row').length >= 5`, { label: "rows at narrow width" });
    await browser.setViewport(760, 900);
    await shot("11-narrow.png");
    await browser.setViewport(WIDTH, HEIGHT);

    log(`\n${written.length} screenshot(s) written to ${OUT_DIR}`);
    log(`page errors: ${browser.errors.length === 0 ? "none" : browser.errors.join(" | ")}`);
    if (browser.errors.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
    await server.close();
    await brokenServer.close();
    demo.cleanup();
    broken.cleanup();
  }
}

await main();
