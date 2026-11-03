/**
 * The six §5.5 criteria, mechanised where they can be.
 *
 * The brief is explicit about which half this file can hold: *"Mechanical parts
 * verified by test (type scale, spacing unit, reduced-motion path, a test per
 * state). The rest requires G4, owner: operator."* So this file tests exactly
 * that half and stops. It does not claim the client is stunning, and a green run
 * here is not a substitute for the operator opening it.
 *
 * Where the terminal and the browser genuinely differ, each rule is expressed
 * natively and named here:
 *
 *  - criterion 1's "≤5 sizes" is a terminal cell count there and a `--fs-1..5`
 *    token set here; this file asserts the set is exactly five and that no rule
 *    invents a size off the scale.
 *  - criterion 3's `NO_MOTION` is an environment flag there and a
 *    `prefers-reduced-motion` media query here; this file asserts the query
 *    exists, that it removes the animation rather than shortening it, and that
 *    the animation is bound to a class only a live arrival sets.
 *  - criterion 4's "never a filled dot" is a glyph choice there and a
 *    `border-style` here — every presence ring is hollow and differs in *shape*,
 *    so the state survives greyscale and colour blindness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const WEB = path.join(import.meta.dirname, "..");
const CSS = fs.readFileSync(path.join(WEB, "public", "app.css"), "utf8");
const APP = fs.readFileSync(path.join(WEB, "public", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(WEB, "public", "index.html"), "utf8");

/** Comments carry prose like "no writeFile"; scans should read code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const CSS_CODE = stripComments(CSS);
const APP_CODE = stripComments(APP);

/** Every declaration of `property` in the stylesheet, in source order. */
function declarations(property: string): string[] {
  return [...CSS_CODE.matchAll(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`, "g"))].map((m) =>
    m[1].trim(),
  );
}

/** The body of one at-rule block, by a prefix match on its prelude. */
function atRuleBody(prelude: string): string {
  const start = CSS_CODE.indexOf(prelude);
  assert.ok(start !== -1, `expected an at-rule beginning ${prelude}`);
  let depth = 0;
  for (let i = start; i < CSS_CODE.length; i += 1) {
    if (CSS_CODE[i] === "{") depth += 1;
    else if (CSS_CODE[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS_CODE.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated at-rule ${prelude}`);
}

/* ── Criterion 1: typography ─────────────────────────────────────────────── */

test("criterion 1 — the type scale is exactly five named sizes", () => {
  const scale = [...CSS_CODE.matchAll(/--fs-(\d+):\s*([^;]+);/g)].map((m) => ({
    step: Number(m[1]),
    value: m[2].trim(),
  }));
  assert.equal(scale.length, 5, `a named scale of five sizes, found ${scale.length}`);
  assert.deepEqual(scale.map((s) => s.step), [1, 2, 3, 4, 5], "steps are contiguous from 1");
  for (const { step, value } of scale) {
    assert.match(value, /^\d*\.?\d+rem$/, `--fs-${step} is a rem value`);
  }
  // Ascending: a scale that is not ordered is five numbers, not a scale.
  const values = scale.map((s) => Number.parseFloat(s.value));
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
});

test("criterion 1 — no rule invents a size off the scale", () => {
  const sizes = declarations("font-size");
  assert.ok(sizes.length > 20, "the stylesheet sets font-size in many places");
  const offScale = sizes.filter((value) => !/^var\(--fs-[1-5]\)$/.test(value));
  assert.deepEqual(offScale, [], "every font-size must be one of the five tokens");
});

test("criterion 1 — one face for prose, one for identifiers, nothing else", () => {
  const families = [...CSS_CODE.matchAll(/--font-(prose|mono):\s*([^;]+);/g)].map((m) => m[1]);
  assert.deepEqual(families, ["prose", "mono"], "exactly two faces are declared");
  const used = [...new Set(declarations("font-family"))];
  assert.deepEqual(
    used.sort(),
    ["var(--font-mono)", "var(--font-prose)"],
    "every rule uses one of the two declared faces",
  );
});

test("criterion 1 — identifiers are monospace: names, ids, timestamps, sequence", () => {
  // The four things the criterion names. Each must be in a mono context.
  const monoBlocks = [
    ...CSS_CODE.matchAll(/([^{}]+)\{([^}]*font-family:\s*var\(--font-mono\)[^}]*)\}/g),
  ].map((m) => m[1]);
  const mono = monoBlocks.join(" ");
  for (const selector of [
    ".row__author", // agent names
    ".row__id", // message ids
    ".row__time", // timestamps
    ".row__seq", // sequence numbers
    ".rail__name", // room names
    ".roster__name", // participant names
    ".receipts", // receipt states
    ".presence", // presence words
  ]) {
    assert.ok(mono.includes(selector), `${selector} must be monospace`);
  }
});

test("criterion 1 — the scale is declared on :root, not per widget", () => {
  const rootBlock = CSS_CODE.match(/:root\s*\{[\s\S]*?\n\}/);
  assert.ok(rootBlock != null, "a :root block must exist");
  for (let step = 1; step <= 5; step += 1) {
    assert.match(rootBlock[0], new RegExp(`--fs-${step}:`), `--fs-${step} lives on :root`);
  }
  // And no other block redeclares one.
  const redeclared = [...CSS_CODE.matchAll(/--fs-[1-5]:/g)].length;
  assert.equal(redeclared, 5, "each size is declared exactly once");
});

/* ── Criterion 2: spacing ────────────────────────────────────────────────── */

test("criterion 2 — one base unit, and every gap is a multiple of it", () => {
  const unit = CSS_CODE.match(/--unit:\s*([^;]+);/);
  assert.ok(unit != null, "the base unit must be declared");
  assert.equal(unit[1].trim(), "4px", "the base unit is a concrete length, not a computed one");

  // Every named step must be an integer multiple of --unit.
  const steps = [...CSS_CODE.matchAll(/--s-(\d+):\s*([^;]+);/g)].map((m) => ({
    step: Number(m[1]),
    value: m[2].trim(),
  }));
  assert.ok(steps.length >= 6, "a usable set of steps");
  for (const { step, value } of steps) {
    if (step === 1) {
      assert.equal(value, "var(--unit)", "--s-1 is the unit itself");
      continue;
    }
    const match = value.match(/^calc\(var\(--unit\)\s*\*\s*([\d.]+)\)$/);
    assert.ok(match != null, `--s-${step} must be calc(var(--unit) * N), got ${value}`);
    const multiple = Number.parseFloat(match[1]);
    assert.equal(multiple % 1, 0, `--s-${step} is a whole multiple of the unit`);
  }
});

test("criterion 2 — no spacing declaration bypasses the scale", () => {
  const spacing = [
    ...CSS_CODE.matchAll(
      /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap|padding-top|padding-right|padding-bottom|padding-left|margin-top|margin-right|margin-bottom|margin-left):\s*([^;]+);/g,
    ),
  ].map((m) => ({ prop: m[1], value: m[2].trim() }));
  assert.ok(spacing.length > 40, "the stylesheet spaces a lot of things");

  const offScale = spacing.filter(({ value }) => {
    const cleaned = value
      // A negative multiple of a named step is still on the scale:
      // `calc(var(--s-3) * -1)` is the unit times three, subtracted.
      .replace(/calc\(var\(--unit\)\s*\*\s*-?[\d.]+\)/g, "")
      .replace(/calc\(var\(--s-\d+\)\s*\*\s*-?[\d.]+\)/g, "")
      .replace(/var\(--s-\d+\)/g, "")
      .replace(/var\(--(row-pad-y|row-gap|gutter|rail|roster|unit)\)/g, "")
      .replace(/var\(--(measure)\)/g, "")
      .replace(/\b0(px)?\b/g, "")
      .replace(/auto|none|inherit/g, "")
      .replace(/[,\s]/g, "");
    return cleaned.length > 0;
  });
  assert.deepEqual(
    offScale.map((s) => `${s.prop}: ${s.value}`),
    [],
    "every gap is a multiple of the base unit",
  );
});

test("criterion 2 — message rows share one fixed left gutter", () => {
  const gutter = CSS_CODE.match(/--gutter:\s*([^;]+);/);
  assert.ok(gutter != null, "the gutter is a declared token");
  // The row grid uses that token, not a per-row number.
  const row = CSS_CODE.match(/\.row\s*\{[^}]*\}/);
  assert.ok(row != null);
  assert.match(row[0], /grid-template-columns:\s*var\(--gutter\)/, "the row reserves the gutter");
  // The gutter rule is drawn once for the whole run, so it reads as a column.
  assert.match(CSS_CODE, /\.log::before\s*\{[^}]*left:\s*var\(--gutter\)/);
  // And gap rows use the same gutter, so a gap does not break the column.
  assert.match(CSS_CODE, /\.gap\s*\{[^}]*grid-template-columns:\s*var\(--gutter\)/);
});

/* ── Criterion 3: motion on arrival ──────────────────────────────────────── */

test("criterion 3 — exactly one arrival animation, one keyframe pair", () => {
  const frames = [...CSS_CODE.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    frames.sort(),
    ["row-arrive", "row-wash", "skeleton-pulse"],
    "the only keyframes are the arrival pair and the loading pulse",
  );

  // The arrival is a single class carrying both of its keyframes.
  const arrive = CSS_CODE.match(/\.row--arrive\s*\{[^}]*\}/);
  assert.ok(arrive != null, "there must be a .row--arrive rule");
  assert.match(arrive[0], /animation:[^;]*row-arrive/);
  assert.match(arrive[0], /row-wash/);
});

test("criterion 3 — reduced motion removes the animation rather than shortening it", () => {
  const reduced = atRuleBody("@media (prefers-reduced-motion: reduce)");
  assert.match(reduced, /\.row--arrive\s*\{\s*animation:\s*none;/, "the arrival is dropped entirely");
  // The loading pulse goes too: a shimmer is motion, and the criterion is about
  // motion, not about one named animation.
  assert.match(reduced, /\.skeleton\s*\{\s*animation:\s*none;/);
  // "Simply present" means opacity stays at its resting value — there must be no
  // rule resurrecting a fade under reduced motion.
  assert.ok(!/animation-name:/.test(reduced), "reduced motion declares no replacement animation");
});

test("criterion 3 — the arrival class is set once, at creation, only for a live post", () => {
  // The class name is applied from a value computed once when the row object is
  // built. There is exactly one place that sets `_arrive: true`, and it is the
  // live `post` path — not the history load, and not a re-render.
  const arrivals = [...APP_CODE.matchAll(/_arrive:\s*(true|false)/g)].map((m) => m[1]);
  const arriving = arrivals.filter((v) => v === "true");
  assert.equal(arriving.length, 1, "exactly one path may animate a row");
  assert.ok(
    arrivals.filter((v) => v === "false").length >= 1,
    "at least one load path must explicitly not animate",
  );

  // History rows explicitly do not animate.
  const history = APP_CODE.match(/const posts = \(data\.posts \?\? \[\]\)\.map[\s\S]{0,220}/);
  assert.ok(history != null, "the history load must be findable");
  assert.match(history[0], /_arrive:\s*false/, "a row loaded from disk never animates");

  // The live append sets it true, and it is the only `_arrive: true`.
  const live = APP_CODE.match(/function appendPost[\s\S]{0,400}/);
  assert.ok(live != null);
  assert.match(live[0], /_arrive:\s*true/);
  assert.equal((APP_CODE.match(/_arrive:\s*true/g) ?? []).length, 1, "exactly one live arrival path");
});

test("criterion 3 — the list is keyed, so an existing row keeps its node and cannot replay", () => {
  // The bug this guards: `<For>` wrapped in a function rebuilds the whole list on
  // every append, so old rows are re-created and their arrival replays. The
  // keyed form takes a getter for `each`.
  assert.match(
    APP_CODE,
    /const Each = \(items, row\) => h\(For, \{ get each\(\) \{ return items\(\); \}, children: row \}\)/,
    "Each must hand For a getter for `each`, so reconciliation is by identity",
  );
  // The second half of the same property, and the one that actually broke: the
  // row source must be a *memo*. A plain function returning freshly-built
  // objects makes every row a new item on every read, which rebuilds the list and
  // replays the arrival — the same failure through a different door. A browser
  // test asserts node identity survives an append; this asserts the shape that
  // makes that possible.
  assert.match(
    APP_CODE,
    /const visibleRows = createMemo\(/,
    "the row source must be a memo, so item identity is stable across reads",
  );
});

test("criterion 3 — motion is declarative: no JS sets or toggles the arrival class", () => {
  const classes = APP_CODE.match(/classList\.[a-z]+/g) ?? [];
  assert.deepEqual(classes, [], "nothing manipulates classes imperatively");
  assert.ok(!/setTimeout\([^)]*arrive/.test(APP_CODE), "no timer re-triggers an arrival");
  // The row's class is a pure function of the row data.
  assert.match(APP_CODE, /function rowClass\(post\)\s*\{/);
});

/* ── Criterion 4: colour encodes state ───────────────────────────────────── */

test("criterion 4 — the four receipt states each have their own colour token", () => {
  for (const [state, token] of [
    ["queued", "--ochre"],
    ["delivered", "--verdigris"],
    ["read", "--indigo"],
    ["unknown", "--ash"],
  ]) {
    const rule = CSS_CODE.match(new RegExp(`\\.receipt--${state} \\.receipt__state\\s*\\{([^}]*)\\}`));
    assert.ok(rule != null, `.receipt--${state} must have a rule`);
    assert.match(rule[1], new RegExp(`color:\\s*var\\(${token}\\)`), `${state} uses ${token}`);
  }
});

test("criterion 4 — unknown is styled as an absence, not a failure", () => {
  const unknown = CSS_CODE.match(/\.receipt--unknown \.receipt__state\s*\{([^}]*)\}/);
  assert.ok(unknown != null);
  // Dotted rule: "no claim here". Never the alarm colour.
  assert.match(unknown[1], /border-bottom-style:\s*dotted/);
  assert.ok(!/var\(--alarm\)/.test(unknown[1]), "unknown is not an error");
});

test("criterion 4 — own vs other author is carried by hue and by a word", () => {
  assert.match(CSS_CODE, /\.row--own \.row__author\s*\{[^}]*color:\s*var\(--flame\)/);
  // And the word, so the distinction survives without colour.
  assert.match(APP_CODE, /h\('span', \{ class: 'row__you' \}, 'you'\)/);
  assert.match(APP_CODE, /post\.from === post\._me \? 'row--own'/);
});

test("criterion 4 — room vs DM is carried by hue and by the tag's text", () => {
  assert.match(CSS_CODE, /\.tag--room\s*\{\s*color:\s*var\(--verdigris\)/);
  assert.match(CSS_CODE, /\.tag--dm\s*\{\s*color:\s*var\(--flame\)/);
  assert.match(APP_CODE, /h\('span', \{ class: 'tag tag--room' \}, 'room'\)/);
  assert.match(APP_CODE, /h\('span', \{ class: 'tag tag--dm' \}, 'dm'\)/);
});

test("criterion 4 — presence is never a filled dot, and every ring is hollow", () => {
  // The token the renderer actually uses. It must be outlined and never filled.
  const ring = CSS_CODE.match(/\.ring\s*\{([^}]*)\}/);
  assert.ok(ring != null, "the ring token must exist");
  assert.match(ring[1], /background:\s*transparent/, "a ring is never filled");
  assert.match(ring[1], /border:\s*1px solid currentColor/);

  // Every presence state uses `.ring`, and none of them fills it.
  for (const state of ["online", "away", "offline", "unknown"]) {
    const rule = CSS_CODE.match(new RegExp(`\\.presence--${state} \\.ring\\s*\\{([^}]*)\\}`));
    assert.ok(rule != null, `.presence--${state} must style the ring`);
    assert.ok(!/background(-color)?:\s*(?!transparent)/.test(rule[1]), `${state} must not fill the ring`);
    assert.ok(!/border-radius:\s*0/.test(rule[1]), `${state} must stay round`);
  }

  // The four states differ in *shape* as well as hue, so colour is a second
  // channel rather than the only one.
  const styles = new Set(
    ["online", "away", "offline", "unknown"].map((state) => {
      const rule = CSS_CODE.match(new RegExp(`\\.presence--${state} \\.ring\\s*\\{([^}]*)\\}`))!;
      const style = rule[1].match(/border-style:\s*([a-z]+)/);
      return style != null ? style[1] : "solid";
    }),
  );
  assert.ok(styles.size >= 3, "presence states must be distinguishable without colour");
});

test("criterion 4 — presence reads as a lease, with the four words and an age", () => {
  // The renderer emits "declared 23m ago", never "online now".
  assert.match(APP_CODE, /declared \$\{s\}s ago/);
  assert.match(APP_CODE, /declared \$\{m\}m ago/);
  assert.match(APP_CODE, /function ageWords/);
  // And the panel says out loud what a lease is. The phrase is split across
  // nodes in hyperscript (`'Presence here is a '`, then a `<strong>`), so both
  // halves are asserted rather than one contiguous string.
  assert.match(APP_CODE, /'Presence here is a ', h\('strong', null, 'lease'\)/);
  assert.match(APP_CODE, /', not liveness: a client writes it and it expires on read\. '/);
  for (const word of ["online", "away", "offline", "unknown"]) {
    assert.match(CSS_CODE, new RegExp(`\\.presence--${word}`), `${word} must have a state style`);
  }
});

test("criterion 4 — the palette has no unused decoration-only hue", () => {
  // Every colour token is referenced by at least one rule beyond its declaration.
  const tokens = [...CSS_CODE.matchAll(/--([a-z][a-z-]*):\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\));/gi)].map(
    (m) => m[1],
  );
  const structural = new Set(["paper", "paper-raised", "paper-sunk", "ink", "ink-soft", "ink-faint",
    "hairline", "hairline-strong", "flame-wash", "alarm-wash", "selection", "focus"]);
  const unused: string[] = [];
  for (const token of tokens) {
    if (structural.has(token)) continue;
    // Every semantic hue needs a site that reads it. The dark-mode block
    // redeclares the token but does not consume it, so one `var()` use is the
    // minimum for "this colour encodes something".
    const uses = (CSS_CODE.match(new RegExp(`var\\(--${token}\\)`, "g")) ?? []).length;
    if (uses < 1) unused.push(token);
  }
  assert.deepEqual(unused, [], "every semantic colour must actually encode something");
});

/* ── Criterion 5: loading / empty / error / unknown ──────────────────────── */

test("criterion 5 — all four states are designed, and each has a rule", () => {
  assert.match(APP_CODE, /function Loading\(\)/, "loading is a component");
  assert.match(APP_CODE, /function Empty\(p\)/, "empty is a component");
  assert.match(APP_CODE, /function ErrorState\(p\)/, "error is a component");
  // `unknown` is a rung of the ladder, not a screen: it is designed in CSS and
  // worded in one place.
  assert.match(CSS_CODE, /\.receipt--unknown/);
  assert.match(APP_CODE, /h\('p', \{ class: 'state__kicker' \}, 'loading'\)/);
  assert.match(APP_CODE, /h\('p', \{ class: 'state__kicker' \}, 'empty'\)/);
});

test("criterion 5 — the error state names which failure and shows the writer's own words", () => {
  const error = APP_CODE.match(/function ErrorState\(p\)[\s\S]{0,700}/);
  assert.ok(error != null);
  // role=alert so it is announced, not merely coloured.
  assert.match(error[0], /role: 'alert'/);
  // The detail is rendered, not swallowed: a blank pane is indistinguishable from
  // an empty room.
  assert.match(error[0], /h\('pre', \{ class: 'state__hint' \}, p\.detail\)/);
  // Kicker, title and body are all distinct fields — one opaque string is not
  // "naming which failure".
  for (const field of ["kicker", "title", "body", "detail"]) {
    assert.match(error[0], new RegExp(`p\\.${field}`), `the error must render ${field}`);
  }
});

test("criterion 5 — a writer that exits non-zero is reported with its stderr and its code", () => {
  const end = APP_CODE.match(/frame\.phase === 'end'[\s\S]{0,600}/);
  assert.ok(end != null);
  assert.match(end[0], /frame\.ok === true/, "a clean exit is not an error");
  assert.match(end[0], /frame\.code/, "the exit code is reported");
  assert.match(end[0], /frame\.stderr/, "the writer's stderr is reported");
  assert.match(end[0], /History below is what it delivered before it stopped/, "the reader says what is known");
});

test("criterion 5 — empty is a state, not a blank pane, and it says how to fill it", () => {
  const empty = APP_CODE.match(/title: `No posts in \$\{openRoom\(\)\} yet\.`/);
  assert.ok(empty != null, "an empty room has its own copy");
  assert.match(APP_CODE, /The room exists and this reader is following it/, "empty explains itself");
  assert.match(APP_CODE, /title: 'No mail in your inbox\.'/, "an empty inbox has its own copy");
  assert.match(APP_CODE, /An empty inbox is a real state, not an error/);
  // And each points at the command that would change it.
  assert.match(APP_CODE, /hint: `bin\/rooms post --room \$\{openRoom\(\)\} --as \$\{me\(\) \?\? 'NAME'\} /);
  assert.match(APP_CODE, /hint: "bin\/rooms dm --to NAME --as SOMEONE/);
});

test("criterion 5 — loading has a skeleton at the row rhythm, not a spinner alone", () => {
  // The reduced-motion override is also a `.skeleton` rule, so pick the one that
  // lays the placeholder out rather than the first textual match.
  const skeletonRules = [...CSS_CODE.matchAll(/\.skeleton\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const skeleton = skeletonRules.filter((body) => body.includes("grid-template-columns"));
  assert.equal(skeleton.length, 1, "exactly one skeleton layout rule");
  assert.match(skeleton[0], /grid-template-columns:\s*var\(--gutter\)/, "the skeleton reserves the gutter");
  assert.match(skeleton[0], /padding:\s*var\(--row-pad-y\)/, "and uses the row's own rhythm");
  assert.match(APP_CODE, /'aria-busy': 'true'/);
});

test("criterion 5 — the pre-boot shell is a legible state, not a blank page", () => {
  assert.match(HTML, /Starting the reader/);
  assert.match(HTML, /If this never changes, the module did not run/);
  assert.match(HTML, /<noscript>/);
});

test("criterion 5 — the error colour is the only alarm colour in the file", () => {
  const alarmUses = [...CSS_CODE.matchAll(/var\(--alarm[^)]*\)/g)].length;
  assert.ok(alarmUses >= 2 && alarmUses <= 6, `the alarm colour is reserved, used ${alarmUses} times`);
});

/* ── Criterion 6: density ────────────────────────────────────────────────── */

test("criterion 6 — one declared density, used by every surface", () => {
  const density = CSS_CODE.match(/--density:\s*([a-z]+);/);
  assert.ok(density != null, "the density must be declared");
  assert.equal(density[1], "comfortable");
  // The row rhythm is a token, and it is not overridden per surface.
  assert.match(CSS_CODE, /--row-pad-y:\s*var\(--s-\d+\)/);
  const overrides = [...CSS_CODE.matchAll(/--row-pad-y:\s*/g)].length;
  assert.equal(overrides, 1, "the row rhythm is declared once, so rooms and DMs share it");
  // Every message row — room or DM, own or other — comes from one `.row` rule.
  const rowRules = [...CSS_CODE.matchAll(/^\.row\s*\{/gm)].length;
  assert.equal(rowRules, 1, "there is exactly one row layout, so density cannot diverge");
});

test("criterion 6 — the roster and the rail use the same unit as the log", () => {
  for (const selector of [".rail", ".roster", ".main"]) {
    const rule = CSS_CODE.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    assert.ok(rule != null, `${selector} must have a rule`);
    assert.match(rule[1], /padding:\s*var\(--s-\d+\)/, `${selector} spacing comes from the scale`);
  }
});

/* ── The reader contract, restated as executable claims ──────────────────── */

test("the client never writes a stamp and never claims presence", () => {
  // An *assignment* is the thing to forbid, so the probe is `=` that is not `==`
  // and not `=>`. A plain `includes` on "roomSeq =" matched the perfectly correct
  // comparison `roomSeq == null` and would have failed a correct client.
  for (const field of ["readAt", "deliveredAt", "queuedAt", "roomSeq"]) {
    const assignment = new RegExp(`\\b${field}\\s*=(?![=>])`);
    assert.ok(
      !assignment.test(APP_CODE),
      `the client must not compute or write ${field}`,
    );
  }
  for (const forbidden of ["writePresence", "markRead", "markDelivered", "archive("]) {
    assert.ok(!APP_CODE.includes(forbidden), `the client must not call ${forbidden}`);
  }
  // It *displays* the receipt ladder and never derives a rung of its own: the
  // states arrive from the server.
  assert.match(APP_CODE, /ladders\(\)\[id\]/);
});

test("the client makes no request that could write", () => {
  const calls = [...APP_CODE.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(calls, [], "no fetch sets a method, so every one is a GET");
  assert.ok(!/fetch\([^)]*api\/(post|dm|ack|join)/.test(APP_CODE), "no fetch targets a write route");
  // EventSource is the only streaming API, and it is a GET by definition.
  assert.match(APP_CODE, /new EventSource\(/);
  assert.ok(!/new WebSocket/.test(APP_CODE), "no socket: the ruling named SSE");
});

test("`unknown` is never rendered as a delivery failure", () => {
  // The label is the server's own word, printed verbatim. A renderer that mapped
  // `unknown` through its own vocabulary is where "not delivered" would come
  // from, so the assertion is that no mapping exists.
  const rung = APP_CODE.match(/function Rung\(delivery\)[\s\S]{0,900}/);
  assert.ok(rung != null, "the rung renderer must exist");
  assert.match(
    rung[0],
    /delivery\.state \+ mark/,
    "the visible label is the state the store reported, plus the witness mark",
  );
  // And it cannot invent a failure word, because it never writes one: the only
  // strings it emits are the recipient, the state, and the mark.
  for (const forbidden of ["not delivered", "failed", "undelivered", "error"]) {
    assert.ok(
      !rung[0].toLowerCase().includes(`'${forbidden}'`),
      `the receipt renderer must not emit the word "${forbidden}"`,
    );
  }
  // And the four rungs are the only ones the renderer styles.
  const rungs = [...CSS_CODE.matchAll(/\.receipt--([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(rungs)].sort(), ["delivered", "queued", "read", "unknown"]);
});

/* ── The strict CSP must stay satisfiable ───────────────────────────────── */

test("no bundle file needs eval, so the CSP needs no 'unsafe-eval'", () => {
  // This is not a style preference. `solid-js/html` compiles each template with
  // `new Function`, and the server sends `script-src 'self'` with no
  // `'unsafe-eval'` — the combination renders a blank page, which is the exact
  // failure criterion 5 forbids and which no source scan of *our* code would
  // have caught. The fix was to use `solid-js/h` (hyperscript), which builds the
  // DOM through `document.createElement`.
  const vendorDir = path.join(WEB, "vendor");
  const browserDir = path.join(WEB, "public");
  const files = [
    ...fs.readdirSync(vendorDir).filter((f) => f.endsWith(".js")).map((f) => path.join(vendorDir, f)),
    ...fs.readdirSync(browserDir).filter((f) => f.endsWith(".js")).map((f) => path.join(browserDir, f)),
  ];
  assert.ok(files.length >= 4, "the bundle must be present");

  for (const file of files) {
    // Comments are stripped first, for the same reason as the filesystem scan
    // above: `app.js` *documents* why it avoids `new Function`, and the
    // documentation of an absence must not read as the presence it warns about.
    // The prose is the most useful part of the file; it should not be illegal.
    const code = stripComments(fs.readFileSync(file, "utf8"));
    const name = path.basename(file);
    assert.ok(!/\bnew Function\b/.test(code), `${name} must not call new Function`);
    assert.ok(!/\beval\s*\(/.test(code), `${name} must not call eval()`);
    // A template-literal tag would be the `html` entry creeping back in.
    assert.ok(!/from ['"]\.\/html\.js['"]/.test(code), `${name} must not import the html tag`);
  }

  // And the server's policy must actually forbid it, so the assertion above is
  // about a real constraint rather than an unused one.
  const server = fs.readFileSync(path.join(WEB, "server", "server.ts"), "utf8");
  const csp = server.match(/"Content-Security-Policy":\s*([\s\S]*?),?\n/);
  assert.ok(csp != null, "the server must set a CSP");
  assert.match(csp[1], /script-src 'self'/);
  assert.ok(!/unsafe-eval/.test(server), "the server must never permit unsafe-eval");
  assert.ok(!/unsafe-inline/.test(server), "nor unsafe-inline");
});

test("every import in the browser bundle resolves to a relative path", () => {
  // A bare specifier would need an import map or a bundler, and there is no build
  // pipeline on purpose. This also catches a vendored file whose specifiers were
  // only half-rewritten — which fails at runtime with a module-resolution error
  // that looks like a blank page.
  const dirs = [path.join(WEB, "vendor"), path.join(WEB, "public")];
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const code = fs.readFileSync(path.join(dir, file), "utf8");
      const specifiers = [...code.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1]);
      for (const specifier of specifiers) {
        assert.ok(
          specifier.startsWith("./") || specifier.startsWith("../"),
          `${file} imports a bare specifier "${specifier}", which a browser cannot resolve`,
        );
      }
    }
  }
});
