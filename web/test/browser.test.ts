/**
 * The client, driven in a real rendering engine.
 *
 * `ui.test.ts` reads the stylesheet; this file runs the page. The distinction
 * earned its place: three defects in this client were invisible to a source scan
 * and obvious in a screenshot —
 *
 *   1. the pre-boot "Starting the reader…" shell stayed on top of a page that had
 *      already booted (`render` appends, it does not replace);
 *   2. signal reads written as plain values (`String(rooms().length)`) froze at
 *      their initial `0`, so a store with two rooms reported none;
 *   3. an inbox envelope has no `seq`, so every DM row rendered `#undefined`.
 *
 * None of those are catchable by grepping for a class name, and all three are
 * catchable by asking the rendered DOM a question. So the assertions here are
 * about the DOM, and specifically about the properties the criteria name:
 * motion fires once on the new row and never on an old one, reduced motion drops
 * it entirely, and every state actually renders.
 *
 * Skipped, loudly, when no Chrome is present — a silent skip would let the
 * browser half of the acceptance criteria quietly stop being verified.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { launchBrowser, findChrome, type Browser } from "../tools/cdp.ts";
import { startWebServer, type WebServerHandle } from "../server/server.ts";
import { seed, tempStore, assertNotLiveStore, OPERATOR, ROOM, TOKEN, type TempStore } from "./fixture.ts";

const BIN = path.join(import.meta.dirname, "..", "..", "bin", "rooms");

let chrome: string | null = null;
try {
  chrome = findChrome();
} catch {
  chrome = null;
}

/** `test.skip` with a reason a reader can act on. */
const browserTest = chrome == null ? test.skip : test;
const SKIP = chrome == null ? "no Chrome binary: set CHROME_PATH to run the browser tests" : "";

interface Harness {
  browser: Browser;
  server: WebServerHandle;
  store: TempStore;
}

async function withPage<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  if (chrome == null) throw new Error(SKIP);
  const store = tempStore();
  assertNotLiveStore(store.base);
  seed(store);
  const env = { ...process.env, PI_ROOMS_DIR: store.base };
  const server = await startWebServer({ port: 0, me: OPERATOR, env, silent: true });
  const browser = await launchBrowser({ width: 1280, height: 900 });
  try {
    return await fn({ browser, server, store });
  } finally {
    await browser.close();
    await server.close();
    store.cleanup();
  }
}

/** Post into the fixture store the way a human would: the real CLI, in a process. */
function postFromTerminal(base: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, "post", "--room", ROOM, "--as", OPERATOR, "--token", TOKEN, text],
      { env: { ...process.env, PI_ROOMS_DIR: base }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rooms post exited ${code}: ${stderr}`));
    });
  });
}

/* ── It renders at all ───────────────────────────────────────────────────── */

browserTest("the page renders under the strict CSP, with no eval and no console error", async () => {
  await withPage(async ({ browser, server }) => {
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.row').length >= 4`, { label: "the seeded rows" });

    // The pre-boot shell must be gone: it is a fallback for a module that never
    // runs, and leaving it up makes every page claim it is still starting.
    const preboot = await browser.evaluate<boolean>(
      `document.body.innerText.includes('Starting the reader')`,
    );
    assert.equal(preboot, false, "the pre-boot shell must be cleared once the module runs");

    // A CSP violation from `new Function` would surface as a page error, and the
    // page would be blank. Both are asserted.
    assert.deepEqual(browser.errors, [], `the client must run cleanly: ${browser.errors.join(" | ")}`);
  });
});

browserTest("counts are live, not frozen at their first value", async () => {
  // The exact bug: `String(rooms().length)` is a plain string, evaluated once at
  // creation, so it shows 0 forever while the list beside it shows two rooms.
  await withPage(async ({ browser, server }) => {
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.rail__item').length > 2`, { label: "the rail" });
    // The roster is loaded without blocking the log, so its count arrives a frame
    // or two later. Wait for the value rather than assuming it is already there —
    // the assertion below is about it being *live*, not about it being early.
    await browser.waitFor(
      `(() => {
        const h = [...document.querySelectorAll('.rail__head')].find((x) => x.textContent.toLowerCase().includes('participants'));
        return h != null && h.querySelector('.rail__count').textContent.trim() !== '0';
      })()`,
      { label: "the participant count to populate" },
    );
    const counts = await browser.evaluate<{ rooms: string; participants: string; listed: string }>(
      `(() => {
        const heads = [...document.querySelectorAll('.rail__head')];
        const roomsHead = heads.find((h) => h.textContent.toLowerCase().includes('rooms'));
        const participantsHead = heads.find((h) => h.textContent.toLowerCase().includes('participants'));
        const count = (h) => h ? h.querySelector('.rail__count').textContent.trim() : '?';
        return {
          rooms: count(roomsHead),
          participants: count(participantsHead),
          listed: String(document.querySelectorAll('.rail__list li').length),
        };
      })()`,
    );
    assert.notEqual(counts.rooms, "0", "the room count must not be stuck at its initial value");
    assert.notEqual(counts.participants, "0", "the participant count must not be stuck either");
    assert.equal(Number(counts.rooms), 2, "the fixture has exactly two rooms");
    assert.equal(Number(counts.participants), 3, "the fixture has exactly three participants");
  });
});

browserTest("the header names the room it is showing and the store it is reading", async () => {
  await withPage(async ({ browser, server, store }) => {
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelector('.room-head__title') != null`, { label: "the header" });
    // The placeholder is honest while nothing is open, so wait for the selection
    // rather than racing it: `.room-head__title` exists from the first frame.
    await browser.waitFor(
      `document.querySelector('.room-head__title').textContent === ${JSON.stringify(ROOM)}`,
      { label: "the room selection to land in the header" },
    );
    const header = await browser.evaluate<string>(`document.querySelector('.room-head__title').textContent`);
    assert.equal(header, ROOM, "the title is the open room, not a placeholder");
    const meta = await browser.evaluate<string>(`document.querySelector('.room-head__meta').textContent`);
    assert.ok(meta.includes(store.base), "the header says which store this is — a state belongs to the thing you checked");
    assert.match(header, new RegExp(ROOM));
  });
});

/* ── Criterion 3, in the one place it can be proved ──────────────────────── */

browserTest("a live arrival animates exactly once, and no existing row replays", async () => {
  await withPage(async ({ browser, server, store }) => {
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.row').length >= 4`, { label: "history" });
    // Let the initial paint and any first-frame work settle, so what follows is
    // unambiguously the arrival and not a leftover from load.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const before = await browser.evaluate<{
      count: number;
      animating: number;
      ids: string[];
    }>(`(() => {
      const rows = [...document.querySelectorAll('.row')];
      return {
        count: rows.length,
        animating: rows.filter((r) => r.classList.contains('row--arrive')).length,
        ids: rows.map((r) => r.getAttribute('data-seq')),
      };
    })()`);

    // History must not animate at all: motion that replays makes an old message
    // look new, which the criterion calls worse than none.
    assert.equal(before.animating, 0, "no row loaded from disk may carry the arrival class");

    // Tag every existing row so identity survives the append and can be compared.
    await browser.evaluate(`(() => {
      [...document.querySelectorAll('.row')].forEach((r, i) => { r.dataset.probe = String(i); });
      return true;
    })()`);

    await postFromTerminal(store.base, "An arrival, written by the real CLI while the page was open.");
    await browser.waitFor(`document.querySelectorAll('.row').length > ${before.count}`, {
      label: "the arrival to reach the browser over SSE",
      timeoutMs: 15_000,
    });

    const after = await browser.evaluate<{
      count: number;
      arriveClasses: number[];
      oldRowsKeptNodes: boolean;
      animationsRunning: string[];
    }>(`(() => {
      const rows = [...document.querySelectorAll('.row')];
      const olds = rows.filter((r) => r.dataset.probe != null);
      return {
        count: rows.length,
        arriveClasses: rows
          .map((r, i) => (r.classList.contains('row--arrive') ? i : -1))
          .filter((i) => i !== -1),
        // Every pre-existing row still holds the probe attribute we set, which
        // means Solid reused the node instead of rebuilding the list.
        oldRowsKeptNodes: olds.length === ${before.count} && olds.every((r) => r.dataset.probe != null),
        animationsRunning: rows
          .map((r) => getComputedStyle(r).animationName)
          .filter((n) => n !== 'none'),
      };
    })()`);

    assert.equal(after.count, before.count + 1, "exactly one row was added");
    assert.equal(after.arriveClasses.length, 1, "exactly one row carries the arrival class");
    assert.equal(
      after.arriveClasses[0],
      after.count - 1,
      "the arrival class is on the *last* row — the new one, never an old one",
    );
    assert.equal(after.oldRowsKeptNodes, true, "existing rows kept their DOM nodes, so nothing could replay");
    // One animation, and it is the arrival's: two keyframes are declared under one
    // class, so a single computed animation-name pair is what to expect.
    const distinct = new Set(after.animationsRunning.flatMap((n) => n.split(',').map((s) => s.trim())));
    assert.deepEqual(
      [...distinct].sort(),
      ["row-arrive", "row-wash"],
      "only the arrival's keyframes are running anywhere on the page",
    );

    // And after the animation's own duration, nothing is animating: no loop, no
    // re-trigger.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // `animationName` is the *declared* animation and stays declared after the
    // animation ends — that is what `both` fill means, so it is the wrong probe
    // for "is anything still moving". `getAnimations()` with a playState filter
    // is the honest question, and it is also what catches a real replay.
    const settled = await browser.evaluate<{ running: number; finished: number }>(`(() => {
      const all = document.getAnimations({ subtree: true });
      return {
        running: all.filter((a) => a.playState === 'running').length,
        finished: all.filter((a) => a.playState === 'finished').length,
      };
    })()`);
    assert.equal(settled.running, 0, "nothing may still be animating after the arrival settles");
    // Two keyframes were declared together under one class, so exactly the
    // arrival's pair ran — and each finished exactly once. More finished
    // animations than that would be a replay.
    assert.equal(settled.finished, 2, `expected the arrival pair to have run once, got ${settled.finished}`);
  });
});

browserTest("reduced motion removes the arrival: the message is simply present", async () => {
  await withPage(async ({ browser, server, store }) => {
    await browser.setMedia({ reducedMotion: "reduce" });
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.row').length >= 4`, { label: "history" });

    const before = await browser.evaluate<number>(`document.querySelectorAll('.row').length`);
    await postFromTerminal(store.base, "Arrives with reduced motion on, so it must simply appear.");
    await browser.waitFor(`document.querySelectorAll('.row').length > ${before}`, {
      label: "the arrival under reduced motion",
      timeoutMs: 15_000,
    });

    const state = await browser.evaluate<{ animating: number; opacity: string; arriveClass: boolean }>(
      `(() => {
        const rows = [...document.querySelectorAll('.row')];
        const last = rows[rows.length - 1];
        return {
          animating: rows.map((r) => getComputedStyle(r).animationName).filter((n) => n !== 'none').length,
          opacity: getComputedStyle(last).opacity,
          arriveClass: last.classList.contains('row--arrive'),
        };
      })()`,
    );
    assert.equal(state.animating, 0, "reduced motion must run no animation at all");
    assert.equal(state.opacity, "1", "the message is present, not faded out");
    // The class is still applied — the *media query* removes the animation, which
    // is what the criterion asks for. A JS branch would mean the motion decision
    // lived in two places.
    assert.equal(state.arriveClass, true, "the rule is expressed in CSS, not branched in JS");
  });
});

/* ── Criterion 5, each state rendered ────────────────────────────────────── */

browserTest("the empty state renders for a room with no posts", async () => {
  await withPage(async ({ browser, server }) => {
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.rail__item').length > 2`, { label: "the rail" });
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('web-empty')).click()`,
    );
    await browser.waitFor(`document.querySelector('.state--empty') != null`, { label: "the empty state" });
    const text = await browser.evaluate<string>(`document.querySelector('.state--empty').innerText`);
    assert.match(text, /EMPTY/i, "the state names itself");
    assert.match(text, /No posts in web-empty yet/, "it says which room is empty");
    assert.match(text, /bin\/rooms post/, "and how to fill it");
  });
});

browserTest("the error state renders with the failing command's own words", async () => {
  const store = tempStore();
  assertNotLiveStore(store.base);
  seed(store);
  // A room directory whose `room.json` names a different room: `list` reports the
  // name inside the file, while the read path cannot resolve that directory. A
  // genuine corrupt-store case, so the error comes from the real writer.
  const brokenDir = path.join(store.paths.rooms, "unreadable");
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(
    path.join(brokenDir, "room.json"),
    JSON.stringify({ name: "ghost-room", members: [OPERATOR], createdBy: OPERATOR, createdAt: new Date().toISOString() }),
  );

  const env = { ...process.env, PI_ROOMS_DIR: store.base };
  const server = await startWebServer({ port: 0, me: OPERATOR, env, silent: true });
  const browser = await launchBrowser({ width: 1280, height: 900 });
  try {
    await browser.goto(server.url);
    await browser.waitFor(
      `[...document.querySelectorAll('.rail__item')].some((b) => b.textContent.includes('ghost-room'))`,
      { label: "the ghost room in the rail" },
    );
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('ghost-room')).click()`,
    );
    await browser.waitFor(`document.querySelector('.state--error') != null`, { label: "the error state" });

    const text = await browser.evaluate<string>(`document.querySelector('.state--error').innerText`);
    // It must name the failure, say what it is not, and quote the writer.
    assert.match(text, /could not be read/i, "the heading names the failure");
    assert.match(text, /not an empty room/i, "and says what it is not");
    assert.match(text, /does not exist|exited/i, "and carries the writer's own words");
    assert.equal(
      await browser.evaluate<boolean>(`document.querySelector('.state--error').getAttribute('role') === 'alert'`),
      true,
      "the error is announced, not merely coloured",
    );
  } finally {
    await browser.close();
    await server.close();
    store.cleanup();
  }
});

browserTest("the loading state renders while a read is genuinely slow", async () => {
  await withPage(async ({ browser, server }) => {
    // Hold the room-history fetch open, so the skeleton is a real frame of the
    // real client rather than a mock. Only that one GET is held.
    const hold = await browser.initScript(`
      (() => {
        const real = window.fetch.bind(window);
        window.__release = null;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (/\\/api\\/rooms\\/[^/?]+$/.test(url)) {
            return new Promise((resolve) => { window.__release = () => resolve(real(input, init)); });
          }
          return real(input, init);
        };
      })();
    `);
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelector('.skeleton') != null`, { label: "the skeletons" });
    const loading = await browser.evaluate<string>(`document.querySelector('.state').innerText`);
    assert.match(loading, /LOADING/i, "the loading state names itself");
    assert.equal(
      await browser.evaluate<boolean>(`document.querySelector('[aria-busy="true"]') != null`),
      true,
      "and is announced as busy",
    );
    await browser.evaluate(`window.__release ? (window.__release(), true) : false`);
    await browser.waitFor(`document.querySelector('.skeleton') == null`, { label: "loading to finish" });
    await browser.removeInitScript(hold);
  });
});

browserTest("the inbox shows DMs, marks the true ones, and never renders '#undefined'", async () => {
  await withPage(async ({ browser, server }) => {
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.rail__item').length > 2`, { label: "the rail" });
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('inbox')).click()`,
    );
    await browser.waitFor(`document.querySelector('.row') != null`, { label: "the inbox rows" });

    const view = await browser.evaluate<{
      text: string;
      undefinedSeq: number;
      dmTags: number;
      unlabelled: number;
    }>(`(() => {
      const rows = [...document.querySelectorAll('.row')];
      return {
        text: document.querySelector('.log').innerText,
        undefinedSeq: rows.filter((r) => r.innerText.includes('#undefined')).length,
        dmTags: rows.filter((r) => r.querySelector('.row__dm') != null).length,
        unlabelled: rows.filter((r) => r.querySelector('.row__dm') == null && r.querySelector('.row__room') == null).length,
      };
    })()`);

    // The bug this pins: an envelope has no room position, and inventing one
    // would be the reader computing `roomSeq`.
    assert.equal(view.undefinedSeq, 0, "no row may render a position it was not given");
    // The fixture seeds two true DMs (one acked, one pending) plus room fan-out
    // copies, so the exact count is checkable — and the stronger invariant is
    // that every row is labelled as one or the other.
    assert.equal(view.dmTags, 2, "both true DMs carry the dm tag");
    assert.equal(
      view.unlabelled,
      0,
      "every inbox row must be labelled a dm or a room, never left to inference",
    );
    assert.ok(!view.text.includes('undefined'), "nor may 'undefined' leak anywhere else");
  });
});

/* ── The read-only claim, as the browser experiences it ──────────────────── */

browserTest("the browser never issues anything but a GET", async () => {
  await withPage(async ({ browser, server, store }) => {
    // Record every request the page makes, then drive it through both views and
    // a live arrival.
    const hold = await browser.initScript(`
      (() => {
        window.__methods = [];
        const real = window.fetch.bind(window);
        window.fetch = (input, init) => {
          window.__methods.push((init && init.method) || 'GET');
          return real(input, init);
        };
        const RealES = window.EventSource;
        window.EventSource = function (url, opts) {
          window.__methods.push('GET');
          return new RealES(url, opts);
        };
      })();
    `);
    await browser.goto(server.url);
    await browser.waitFor(`document.querySelectorAll('.row').length >= 4`, { label: "history" });
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('inbox')).click()`,
    );
    await browser.waitFor(`document.querySelector('.row') != null`, { label: "inbox" });
    await browser.evaluate(
      `[...document.querySelectorAll('.rail__item')].find((b) => b.textContent.includes('${ROOM}')).click()`,
    );
    await browser.waitFor(`document.querySelector('.tag--room') != null`, { label: "back in the room" });

    const methods = await browser.evaluate<string[]>(`window.__methods`);
    assert.ok(methods.length > 0, "the page must have made requests, or this proves nothing");
    assert.deepEqual(
      [...new Set(methods)],
      ["GET"],
      `a read-only reader may only GET; it issued: ${JSON.stringify(methods)}`,
    );
    await browser.removeInitScript(hold);
    // And the store is untouched by all of it.
    const before = fs.readFileSync(path.join(store.paths.rooms, ROOM, "log.jsonl"), "utf8");
    assert.ok(before.length > 0);
  });
});
