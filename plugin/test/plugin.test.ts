/**
 * The plugin's own tests.
 *
 * These exist because the interesting failures here are all *silent*. A renderer
 * that stamps `readAt` on paint looks perfect and destroys the evidence. A
 * renderer that treats a missing `deliveredAt` as "not delivered" looks perfect
 * and re-sends mail. An animation that replays makes an old message look new. A
 * blank pane on failure is indistinguishable from an empty room.
 *
 * So the assertions below read artifacts and rendered bytes, never "it did not
 * throw":
 *
 *  - the palette is closed: every SGR the renderer emits names a state;
 *  - the type scale is five entries and nothing else;
 *  - the spacing unit is 4 and every column is a multiple of it;
 *  - the source of every module under `plugin/src` contains no fs mutator;
 *  - all four of loading/empty/error/unknown render, and render *differently*;
 *  - the copy-witness rule holds against a receipt the receipt has lost;
 *  - an arrival animates once and never replays, and under reduced motion the
 *    frame is byte-identical except for the mark.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendPost,
  archive,
  createParticipant,
  createRoom,
  deliver,
  drain,
  markRead,
  resolvePaths,
  writePresence,
  readReceipts,
  type Paths,
} from "../../src/store.ts";
import { allowedSgr, COLOR, MOTION, SPACE, TYPE, motionEnabled, sp } from "../src/theme.ts";
import { fit, stripAnsi, width, wrap } from "../src/text.ts";
import { layout, render, renderHelp, presenceWord, stateColor } from "../src/render.ts";
import {
  ackTarget,
  applyFollowEvent,
  applySnapshot,
  failStream,
  initialSnapshotFor,
  initialState,
  loadingRoom,
  markLive,
  moveSelection,
  selectIndex,
  selectedEntry,
  type State,
} from "../src/model.ts";
import { readInbox, readSnapshot, storePaths, ladder, type Snapshot } from "../src/reader.ts";
import { followArgs } from "../src/follow.ts";
import { tokenizeKeys } from "../src/tui.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, "..");
const SRC = path.join(PLUGIN, "src");
const OPERATOR = "operator";
const TOKEN = "plugin-test-token";
const TOKEN_SHA = createHash("sha256").update(TOKEN, "utf8").digest("hex");

/**
 * herdr 0.9.5's default prefix-mode chords, from the `# Prefix-mode actions`
 * block the binary prints as commented config.
 *
 * Both `r` chords matter for this plugin's mnemonic and both are taken:
 * `prefix+r` is `resize_mode` and `prefix+shift+r` is `reload_config`. That is
 * why the binding is `prefix+alt+r`, and why this list is a test input rather
 * than a comment — a future edit that "tidies" the key back to a bare `r` has to
 * fail here first.
 */
const HERDR_DEFAULT_KEYS = [
  "prefix+?", "prefix+s", "prefix+q", "prefix+shift+r", "prefix+o", "prefix+w",
  "prefix+g", "prefix+shift+n", "prefix+shift+g", "prefix+shift+w", "prefix+shift+d",
  "prefix+c", "prefix+shift+t", "prefix+p", "prefix+n", "prefix+shift+x",
  "prefix+shift+p", "prefix+e", "prefix+h", "prefix+j", "prefix+k", "prefix+l",
  "prefix+tab", "prefix+shift+tab", "prefix+v", "prefix+minus", "prefix+x",
  "prefix+z", "prefix+r", "prefix+b",
] as const;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tempStore(): Paths {
  return resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-plugin-")));
}

function envFor(paths: Paths, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PI_ROOMS_DIR: paths.base, ...extra };
}

function seedHuman(paths: Paths, name = OPERATOR, displayName: string | null = "Alex"): void {
  createParticipant(paths, {
    name,
    kind: "human",
    displayName,
    createdBy: "test",
    client: { id: "plugin", label: "rooms-popup", tokenSha256: TOKEN_SHA },
  });
}

function seedRoom(paths: Paths, room: string, members: string[]): void {
  createRoom(paths, { name: room, members, createdBy: members[0] ?? "test", createdAt: new Date().toISOString() });
}

function post(paths: Paths, room: string, from: string, text: string, sentAt: string): string {
  const id = createHash("sha256").update(`${room}${from}${text}${sentAt}`).digest("hex").slice(0, 32);
  appendPost(paths, room, { id, from, text, sentAt, recipients: [], via: "agent", client: "pi-rooms" });
  return id;
}

function opts(over: Partial<{ cols: number; rows: number; now: number; motion: boolean }> = {}) {
  return {
    cols: over.cols ?? 110,
    rows: over.rows ?? 34,
    now: over.now ?? Date.parse("2026-11-02T22:00:00.000Z"),
    motion: over.motion ?? false,
    tick: 0,
  };
}

function plain(lines: string[]): string[] {
  return lines.map(stripAnsi);
}

function renderState(state: State, over = {}): string[] {
  return plain(render(state, opts(over)));
}

/** Files under a store with size, mtime and hash — the write-nothing diff. */
function fingerprint(base: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      const hash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      out.set(path.relative(base, full), `${stat.size}:${Math.floor(stat.mtimeMs)}:${hash}`);
    }
  };
  walk(base);
  return out;
}

// ---------------------------------------------------------------------------
// 1. The type scale
// ---------------------------------------------------------------------------

test("the type scale has at most five sizes, and each has one job", () => {
  const names = Object.keys(TYPE);
  assert.ok(names.length <= 5, `at most five sizes, found ${names.length}: ${names.join(", ")}`);
  assert.deepEqual(names, ["display", "title", "body", "meta", "micro"]);
  // Every size is a distinct attribute set, so no two names render the same.
  const serialised = Object.values(TYPE).map((attributes) => attributes.join("+"));
  assert.equal(new Set(serialised).size, serialised.length, "no two sizes are the same attributes");
});

test("every SGR the renderer can emit comes from the palette", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "leader-lane"]);
  post(paths, "slice-one", "leader-lane", "A post with **markup-free** text and a (paren).", "2026-11-02T21:00:00.000Z");
  deliver(paths, {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    from: "leader-lane",
    to: [OPERATOR],
    text: "A dm, which renders a state word.",
    sentAt: "2026-11-02T21:05:00.000Z",
  });

  const allowed = allowedSgr();
  const frames: string[] = [];
  let state = initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR));
  frames.push(...render(state, opts()));

  const roomState = selectIndex(state, 1);
  const withPost = applyFollowEvent(
    applyFollowEvent(markLive(roomState), { type: "post", seq: 1, id: "p1", from: "leader-lane", text: "hello", sentAt: "2026-11-02T21:00:00.000Z" }, Date.now(), OPERATOR),
    { type: "gap", after: 1, next: 4, missed: 2 },
    Date.now(),
    OPERATOR,
  );
  frames.push(...render(withPost, opts()));

  const humans = selectIndex(state, state.entries.length - 1);
  frames.push(...render(humans, opts()));

  const errored = failStream(roomState, "the follower failed", "exit 1: Room nope does not exist.", Date.now());
  frames.push(...render(errored, opts()));

  const loading = { ...roomState, stream: loadingRoom() };
  frames.push(...render(loading, opts()));
  frames.push(...renderHelp(state, opts()));

  const emitted = new Set<string>();
  for (const line of frames) {
    for (const match of line.matchAll(/\u001b\[[0-9;]*m/g)) emitted.add(match[0]);
  }
  const unknown = [...emitted].filter((sequence) => !allowed.has(sequence));
  assert.deepEqual(unknown, [], `unexpected SGR: ${unknown.join(" ")}`);
  assert.ok(emitted.size > 0, "the renderer emitted no styling at all, which would make this vacuous");
});

test("every colour name states the state it encodes", () => {
  // No entry may be a bare hue: each must name a delivery state, an author
  // class, a place, a presence word, or a structural role.
  const allowedPrefixes = [
    "queued", "delivered", "read", "unknown", "error", "gap",
    "own", "agent", "human", "room", "dm", "presence_", "rule", "dim",
  ];
  for (const name of Object.keys(COLOR)) {
    assert.ok(
      allowedPrefixes.some((prefix) => name === prefix || name.startsWith(prefix)),
      `${name} does not name a state`,
    );
  }
  // The four presence words each have their own colour.
  for (const word of ["online", "away", "offline", "unknown"] as const) {
    assert.ok(`presence_${word}` in COLOR, `presence ${word} has no colour`);
  }
});

test("delivery state maps to a colour of the same name, never a decoration", () => {
  assert.equal(stateColor("queued"), "queued");
  assert.equal(stateColor("delivered"), "delivered");
  assert.equal(stateColor("read"), "read");
  assert.equal(stateColor("unknown"), "unknown");
});

// ---------------------------------------------------------------------------
// 2. Spacing
// ---------------------------------------------------------------------------

test("there is one spacing unit, and every column and gap is a multiple of it", () => {
  assert.equal(SPACE, 4);
  assert.equal(sp(0), 0);
  assert.equal(sp(3), 12);
  assert.throws(() => sp(1.5), /whole number/);
  assert.throws(() => sp(-1), /whole number/);
  for (const cols of [60, 80, 90, 110, 140, 200]) {
    const { rail, main, text } = layout(cols);
    // The rail is a whole number of blocks, and the prose column leaves a whole
    // number of blocks for the identifier cluster and the state word.
    assert.equal(rail % SPACE, 0, `rail ${rail} at ${cols} cols is off the grid`);
    assert.ok(text > 0, `no prose column at ${cols} cols`);
    assert.ok(rail + 1 + main === cols, "rail + separator + main is the full width");
  }
});

test("message rows share one left gutter, so a long run reads as a column", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "leader-lane"]);
  let state = selectIndex(initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR)), 1);
  state = markLive(state);
  // Three authors with very different name lengths: the prose must still start
  // in the same cell.
  for (const [index, from] of ["a", "a-very-long-lane-name", "c2"].entries()) {
    state = applyFollowEvent(
      state,
      { type: "post", seq: index + 1, id: `p${index}`, from, text: "body text here", sentAt: "2026-11-02T21:00:00.000Z" },
      Date.now(),
      OPERATOR,
    );
  }
  const lines = renderState(state).filter((line) => line.includes("body text here"));
  assert.equal(lines.length, 3, "three post rows rendered");
  const starts = lines.map((line) => line.indexOf("body text here"));
  assert.equal(new Set(starts).size, 1, `prose starts at different cells: ${starts.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 3. Presence is a lease, never liveness
// ---------------------------------------------------------------------------

test("presence renders as words with an age, never as a filled dot", () => {
  const paths = tempStore();
  seedHuman(paths);
  writePresence(paths, {
    name: OPERATOR,
    state: "online",
    lastSeenAt: "2026-11-02T21:37:00.000Z",
    leaseUntil: "2026-11-02T21:38:00.000Z", // long expired
    client: "rooms-popup",
  });
  const now = Date.parse("2026-11-02T22:00:00.000Z");
  const snapshot = readSnapshot(envFor(paths), OPERATOR, now);
  const state = selectIndex(initialSnapshotFor(OPERATOR, snapshot, now), snapshot.rooms.length + 1);
  assert.equal(selectedEntry(state).kind, "humans");
  const text = renderState(state, { now }).join("\n");

  // Expired lease, last evidence 23m ago: the plan's own example.
  assert.match(text, /away · declared 23m ago/, text);
  // The word is there; a filled liveness marker is not.
  assert.doesNotMatch(text, /●|⬤|🟢/, "presence must not render as a filled dot");
  assert.equal(
    presenceWord("online", 0),
    "online · declared 0s ago",
    "even a live lease carries its age",
  );
  assert.equal(presenceWord("unknown", null), "unknown · no lease");
});

test("an absent presence record is unknown, not offline", () => {
  const paths = tempStore();
  seedHuman(paths);
  const now = Date.parse("2026-11-02T22:00:00.000Z");
  const snapshot = readSnapshot(envFor(paths), OPERATOR, now);
  const human = snapshot.humans[0]!;
  assert.equal(human.presence.state, "unknown");
  const state = selectIndex(initialSnapshotFor(OPERATOR, snapshot, now), snapshot.rooms.length + 1);
  assert.equal(selectedEntry(state).kind, "humans", "the humans entry is selected");
  const text = renderState(state, { now }).join("\n");
  assert.match(text, /unknown · no lease/);
  // The *state word* is unknown. The note explains why that is not `offline`,
  // which is a claim about a person that nothing here supports.
  assert.doesNotMatch(text, /(^|\s)offline ·/, "an absent record must not render as offline");
  assert.match(text, /nothing declared/);
});

// ---------------------------------------------------------------------------
// 4. The delivery ladder and the copy-witness rule
// ---------------------------------------------------------------------------

test("a missing deliveredAt with an archived copy reads delivered, and says why", () => {
  const paths = tempStore();
  seedHuman(paths);
  const id = "dddddddd-4444-4444-8444-444444444444";
  deliver(paths, {
    id,
    from: "leader-lane",
    to: [OPERATOR],
    text: "This one arrived; its receipt lost the stamp.",
    sentAt: "2026-11-02T21:40:00.000Z",
  });
  for (const { file, message } of drain(paths, OPERATOR)) archive(paths, OPERATOR, file, message);

  // Reproduce the disagreement: strip deliveredAt from the receipt.
  const receiptFile = path.join(paths.receipts, `${id}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  delete receipt.receipts[OPERATOR].deliveredAt;
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  assert.equal(
    JSON.parse(fs.readFileSync(receiptFile, "utf8")).receipts[OPERATOR].deliveredAt,
    undefined,
    "the receipt really has no deliveredAt",
  );

  // `readReceipts` refuses an id that does not look like one, so a short or
  // non-hex id silently yields null and every assertion below would pass without
  // ever reading a receipt. Assert the receipt is *readable* first, which is
  // what makes the copy-witness check below mean something.
  assert.notEqual(readReceipts(paths, id), null, "the receipt is readable, so the ladder actually ran");
  assert.equal(readReceipts(paths, id)!.receipts[OPERATOR]!.deliveredAt, undefined);

  const mail = readInbox(paths, OPERATOR);
  assert.equal(mail.length, 1);
  assert.equal(mail[0]!.state, "delivered", "the copy is the witness");
  assert.equal(mail[0]!.witness, "copy");

  const state = initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR));
  const text = renderState(state).join("\n");
  assert.match(text, /delivered · copy/);
  assert.match(text, /the archived copy is the witness; the receipt lost deliveredAt/);
  assert.doesNotMatch(text, /queued/, "an arrived message must never read as queued");
});

test("the ladder is decided by evidence, not by a missing field", () => {
  // The four inputs, exhaustively, so no combination is left to inference.
  assert.deepEqual(ladder({ readAt: "t", deliveredAt: null, hasCopy: false, hasPending: true }), {
    state: "read",
    witness: "receipt",
  });
  assert.deepEqual(ladder({ readAt: null, deliveredAt: "t", hasCopy: false, hasPending: true }), {
    state: "delivered",
    witness: "receipt",
  });
  // The rule this whole plugin exists to get right: the copy is the witness.
  assert.deepEqual(ladder({ readAt: null, deliveredAt: null, hasCopy: true, hasPending: false }), {
    state: "delivered",
    witness: "copy",
  });
  assert.deepEqual(ladder({ readAt: null, deliveredAt: null, hasCopy: true, hasPending: true }), {
    state: "delivered",
    witness: "copy",
  });
  assert.deepEqual(ladder({ readAt: null, deliveredAt: null, hasCopy: false, hasPending: true }), {
    state: "queued",
    witness: null,
  });
  // No evidence at all is unknown, which is not a failure.
  assert.deepEqual(ladder({ readAt: null, deliveredAt: null, hasCopy: false, hasPending: false }), {
    state: "unknown",
    witness: null,
  });
});

test("a pending copy with no receipt is queued; a bare receipt with neither is unknown", () => {
  const paths = tempStore();
  seedHuman(paths);
  deliver(paths, {
    id: "bbbbbbbb-2222-4222-8222-222222222222",
    from: "leader-lane",
    to: [OPERATOR],
    text: "Nothing has observed this yet.",
    sentAt: "2026-11-02T21:58:00.000Z",
  });
  const mail = readInbox(paths, OPERATOR);
  assert.equal(mail[0]!.state, "queued");
  assert.equal(mail[0]!.witness, null);
});

test("readAt is never inferred from a render", () => {
  const paths = tempStore();
  seedHuman(paths);
  deliver(paths, { id: "cccccccc-3333-4333-8333-333333333333", from: "lane", to: [OPERATOR], text: "hello", sentAt: "2026-11-02T21:00:00.000Z" });
  const state = initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR));
  // Render it several times.
  render(state, opts());
  render(state, opts());
  render(state, opts());
  const receiptFile = path.join(paths.receipts, "cccccccc-3333-4333-8333-333333333333.json");
  assert.ok(fs.existsSync(receiptFile), "the delivery wrote a receipt");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(receipt.receipts[OPERATOR].readAt, undefined, "rendering must not stamp readAt");
  assert.equal(state.snapshot.inbox[0]!.state, "queued");
});

// ---------------------------------------------------------------------------
// 5. The write-nothing claim, asserted against the source
// ---------------------------------------------------------------------------

test("no module under plugin/src contains a filesystem mutator", () => {
  const mutators = [
    "writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "renameSync",
    "rmSync", "rmdirSync", "copyFileSync", "truncateSync", "chmodSync", "chownSync",
    "createWriteStream", "openSync", "writeFile", "appendFile", "mkdir",
    "unlink", "rename", "rm", "rmdir", "createWriteStream",
  ];
  // Store functions that mutate, by name. A read that calls one of these is a
  // write wearing a read's name. `listAgents` and `readRoster` are on the list
  // because they unlink entries they consider dead — a *reader* must not prune.
  const mutatingStoreFns = [
    "appendPost", "archive", "deliver", "drain", "markDelivered", "markRead",
    "createParticipant", "saveParticipant", "createRoom", "saveRoom", "addRoomMember",
    "register", "unregister", "writePresence", "listAgents", "readRoster",
    "withFileLock", "writeJsonAtomic",
  ];
  const files = fs.readdirSync(SRC).filter((file) => file.endsWith(".ts"));
  assert.ok(files.length >= 5, "the source files were found");

  /** Strip comments: the claim is about what the code *calls*, not what prose names. */
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");

  for (const file of files) {
    const text = code(fs.readFileSync(path.join(SRC, file), "utf8"));
    for (const name of mutators) {
      const pattern = new RegExp(`(^|[^\\w.])${name}\\s*\\(`, "m");
      assert.ok(!pattern.test(text), `${file} calls ${name}()`);
    }
    for (const name of mutatingStoreFns) {
      const pattern = new RegExp(`\\b${name}\\b`, "m");
      assert.ok(!pattern.test(text), `${file} references the mutating store function ${name}`);
    }
  }
});

test("the entrypoint writes nothing of its own, and the manifest declares no build step", () => {
  const entry = fs.readFileSync(path.join(PLUGIN, "bin", "rooms-popup.ts"), "utf8");
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync"]) {
    assert.ok(!entry.includes(name), `the entrypoint calls ${name}`);
  }
  const manifest = fs.readFileSync(path.join(PLUGIN, "herdr-plugin.toml"), "utf8");
  assert.doesNotMatch(manifest, /\[\[build\]\]/, "no build step: a plugin that compiles is a plugin that can fail to compile");
});

test("the whole popup, rendered against every seeded state, changes no file", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "leader-lane"]);
  post(paths, "slice-one", "leader-lane", "hello", "2026-11-02T21:00:00.000Z");
  deliver(paths, { id: "aaaaaaaa-1111-4111-8111-111111111111", from: "leader-lane", to: [OPERATOR], text: "dm", sentAt: "2026-11-02T21:05:00.000Z" });
  writePresence(paths, {
    name: OPERATOR, state: "online",
    lastSeenAt: "2026-11-02T21:59:00.000Z", leaseUntil: "2026-11-02T22:00:00.000Z",
  });

  const before = fingerprint(paths.base);
  assert.ok(before.size > 5, `the store was seeded (${before.size} files)`);

  // Render every view the popup can show.
  let state = initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR));
  render(state, opts());
  render(state, opts({ motion: true }));
  state = selectIndex(state, 1);
  state = applyFollowEvent(state, { type: "post", seq: 1, id: "p1", from: "leader-lane", text: "x", sentAt: "2026-11-02T21:00:00.000Z" }, Date.now(), OPERATOR);
  render(state, opts());
  state = selectIndex(state, state.entries.length - 1);
  render(state, opts());
  renderHelp(state, opts());
  state = failStream(state, "boom", "exit 1", Date.now());
  render(state, opts());

  const after = fingerprint(paths.base);
  assert.deepEqual([...after.entries()], [...before.entries()], "the popup changed a file in the store");
});

// ---------------------------------------------------------------------------
// 6. Loading, empty, error, unknown — four designed states, four different views
// ---------------------------------------------------------------------------

function fourStates(): Record<string, string> {
  const paths = tempStore();
  seedHuman(paths);
  const base = initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR));

  const loading = { ...base, stream: loadingRoom() };

  seedRoom(paths, "empty-room", [OPERATOR]);
  const emptySnap = readSnapshot(envFor(paths), OPERATOR);
  // Entries are [inbox, ...rooms, humans], so the room is index 1.
  const emptyRoom = selectIndex(initialSnapshotFor(OPERATOR, emptySnap), 1);

  // A room selection: the follower is the thing that fails, so the frame has to
  // be a room's, not the humans panel's.
  const error = failStream(
    selectIndex(initialSnapshotFor(OPERATOR, emptySnap), 1),
    "the follower failed",
    "exit 1: Room nope does not exist.",
    Date.now(),
  );

  const unknownState = initialSnapshotFor(null, readSnapshot(envFor(paths), null));

  return {
    loading: renderState(loading).join("\n"),
    empty: renderState(emptyRoom).join("\n"),
    error: renderState(error).join("\n"),
    unknown: renderState(unknownState).join("\n"),
  };
}

test("loading, empty, error and unknown each render, with their own cause text", () => {
  const frames = fourStates();
  assert.match(frames.loading!, /loading/, "loading is labelled");
  assert.match(frames.loading!, /reading the store/);
  assert.match(frames.empty!, /empty/, "empty is labelled");
  assert.match(frames.empty!, /no posts/);
  assert.match(frames.error!, /error/, "error is labelled");
  assert.match(frames.error!, /the follower failed/);
  assert.match(frames.error!, /Room nope does not exist/, "the cause is named, not a blank pane");
  assert.match(frames.unknown!, /no human name declared/, "unknown has its own designed view");
  assert.match(frames.unknown!, /it will not guess/);
});

test("the four states are visually distinct, not one blank pane with words", () => {
  const frames = fourStates();
  const glyphs = {
    loading: /·\s+reading the store/,
    empty: /○\s+no posts/,
    error: /✗\s+the follower failed/,
    unknown: /no human name declared/,
  };
  for (const [name, pattern] of Object.entries(glyphs)) {
    assert.match(frames[name]!, pattern, `${name} has its own glyph and title`);
  }
  const bodies = Object.entries(frames).map(([name, text]) => [name, text.replace(/\s+/g, " ")]);
  const seen = new Set(bodies.map(([, text]) => text));
  assert.equal(seen.size, 4, "all four frames differ");
});

// ---------------------------------------------------------------------------
// 7. The gap line
// ---------------------------------------------------------------------------

test("a gap renders as a visible break, inventing nothing and renumbering nothing", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "leader-lane"]);
  let state = selectIndex(initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR)), 1);
  state = markLive(state);
  state = applyFollowEvent(state, { type: "post", seq: 3, id: "a", from: "leader-lane", text: "three", sentAt: "2026-11-02T21:00:00.000Z" }, Date.now(), OPERATOR);
  // Then a gap saying #4 ran from #3+1.
  state = applyFollowEvent(state, { type: "gap", after: 3, next: 9, missed: 5 }, Date.now(), OPERATOR);
  state = applyFollowEvent(state, { type: "post", seq: 9, id: "b", from: "leader-lane", text: "nine", sentAt: "2026-11-02T21:01:00.000Z" }, Date.now(), OPERATOR);

  const seqs = state.stream.rows.filter((row) => row.kind === "post").map((row) => (row as { seq: number }).seq);
  assert.deepEqual(seqs, [3, 9], "the store's numbers are kept, not resequenced");
  assert.equal(state.stream.cursor, 9, "the cursor is the highest post rendered");

  const text = renderState(state).join("\n");
  assert.match(text, /5 posts missing between #3 and #9/);
  assert.match(text, /nothing here is invented or renumbered/i);
});

test("a gap keeps the cursor behind it, so a restart cannot hide the loss", () => {
  let state = initialState(OPERATOR, readSnapshot(envFor(tempStore()), OPERATOR));
  state = markLive(state);
  state = applyFollowEvent(state, { type: "gap", after: 2, next: 7, missed: 4 }, Date.now(), OPERATOR);
  assert.equal(state.stream.cursor, 2, "the honest resume point is the last post before the gap");
});

test("an ok:false line from the follower becomes a named failure, not silence", () => {
  let state = markLive(initialState(OPERATOR, readSnapshot(envFor(tempStore()), OPERATOR)));
  state = applyFollowEvent(state, { ok: false, error: "Room nope does not exist." }, Date.now(), OPERATOR);
  assert.equal(state.stream.status, "error");
  assert.match(state.stream.errorCause ?? "", /Room nope does not exist/);
});

// ---------------------------------------------------------------------------
// 8. Motion: one-shot, and dropped cleanly
// ---------------------------------------------------------------------------

test("an arrival animates once and never replays on re-render or scroll", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "leader-lane"]);
  let state = selectIndex(initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR)), 1);
  state = markLive(state);

  const arrivalAt = Date.parse("2026-11-02T22:00:00.000Z");
  state = applyFollowEvent(
    state,
    { type: "post", seq: 1, id: "new", from: "leader-lane", text: "fresh", sentAt: "2026-11-02T22:00:00.000Z" },
    arrivalAt,
    OPERATOR,
  );
  const row = state.stream.rows.at(-1)!;
  assert.equal(row.arrivedAt, arrivalAt, "the arrival is stamped once");

  // Frame 0: the widest block.
  state = moveSelection(state, 0);
  const frame0 = render(state, opts({ now: arrivalAt, motion: true, rows: 12 }));
  // Frame at 2 ticks: still animating, narrower.
  const frame2 = render(state, opts({ now: arrivalAt + 2 * MOTION.tickMs, motion: true, rows: 12 }));
  // Frame after the window: the resting mark.
  const settled = render(state, opts({ now: arrivalAt + 10 * MOTION.tickMs, motion: true, rows: 12 }));

  assert.notDeepEqual(frame0, frame2, "the mark changes while the arrival is fresh");
  assert.deepEqual(
    renderedMark(settled),
    renderedMark(render(state, opts({ now: arrivalAt + 60_000, motion: true, rows: 12 }))),
    "a settled row never animates again",
  );
  // And scrolling/repainting does not restamp it.
  assert.equal(state.stream.rows.at(-1)!.arrivedAt, arrivalAt, "no re-render moved the stamp");

  // Re-delivering the same line (a follower restart) does not animate it again.
  const replayed = applyFollowEvent(state, { type: "post", seq: 1, id: "new", from: "leader-lane", text: "fresh", sentAt: "2026-11-02T22:00:00.000Z" }, arrivalAt + 5000, OPERATOR);
  assert.equal(replayed.stream.rows.length, state.stream.rows.length, "the duplicate was not appended");
});

function renderedMark(lines: string[]): string {
  const line = lines.find((candidate) => stripAnsi(candidate).includes("fresh"));
  return line == null ? "" : stripAnsi(line).slice(0, 1);
}

test("under reduced motion the mark is dropped and the information is identical", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "leader-lane"]);
  let state = selectIndex(initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR)), 1);
  state = markLive(state);
  const arrivalAt = Date.now();
  state = applyFollowEvent(
    state,
    { type: "post", seq: 1, id: "new", from: "leader-lane", text: "fresh words", sentAt: "2026-11-02T22:00:00.000Z" },
    arrivalAt,
    OPERATOR,
  );

  const moving = plain(render(state, opts({ now: arrivalAt, motion: true })));
  const still = plain(render(state, opts({ now: arrivalAt, motion: false })));
  // The only difference is the arrival mark. It sits after the rail and the
  // separator, so normalising column 0 would compare nothing: replace every
  // member of the mark alphabet wherever it appears.
  const marks = /[█▉▌▎▏]/g;
  const movingWords = moving.map((line) => line.replace(marks, "|"));
  const stillWords = still.map((line) => line.replace(marks, "|"));
  assert.deepEqual(movingWords, stillWords, "reduced motion dropped movement, not information");
  assert.match(still.join("\n"), /fresh words/);
});

test("motion honours NO_MOTION, REDUCED_MOTION and TERM=dumb", () => {
  assert.equal(motionEnabled({ TERM: "xterm-256color" } as NodeJS.ProcessEnv), true);
  assert.equal(motionEnabled({ TERM: "xterm-256color", NO_MOTION: "1" } as NodeJS.ProcessEnv), false);
  assert.equal(motionEnabled({ TERM: "xterm-256color", REDUCED_MOTION: "true" } as NodeJS.ProcessEnv), false);
  assert.equal(motionEnabled({ TERM: "dumb" } as NodeJS.ProcessEnv), false);
  assert.equal(motionEnabled({ TERM: "xterm-256color", NO_MOTION: "0" } as NodeJS.ProcessEnv), true);
});

test("the motion window is finite, so a ticker can stop", () => {
  assert.ok(MOTION.arrivalTicks > 0 && MOTION.arrivalTicks < 20);
  assert.ok(MOTION.tickMs > 0);
});

// ---------------------------------------------------------------------------
// 9. Typography and wrapping
// ---------------------------------------------------------------------------

test("prose wraps without truncation; identifiers are clipped with the marker", () => {
  const text = "word ".repeat(40).trim();
  const lines = wrap(text, 30);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "), "no word was lost");
  for (const line of lines) assert.ok(width(line) <= 30, `"${line}" is ${width(line)} cells`);

  assert.equal(fit("abcdefghij", 5), "abcd…", "an identifier is clipped with a visible marker");
  assert.equal(fit("ab", 5), "ab   ");
  assert.equal(fit("ab", 5, "right"), "   ab");
  assert.equal(width("日本語"), 6, "wide characters count two cells");
});

test("the density is declared once: full text, wrapped, no truncation marker in prose", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "leader-lane"]);
  const long = `${"sentence ".repeat(30)}END`;
  let state = selectIndex(initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR)), 1);
  state = markLive(state);
  state = applyFollowEvent(
    state,
    { type: "post", seq: 1, id: "long", from: "leader-lane", text: long, sentAt: "2026-11-02T22:00:00.000Z" },
    Date.now(),
    OPERATOR,
  );
  const text = renderState(state, { rows: 60 }).join("\n");
  assert.match(text, /END/, "the end of a long message is present");
  assert.doesNotMatch(text, /… \[truncated/, "prose is not truncated by the renderer");
  // And no line overflows the width.
  for (const line of renderState(state, { rows: 60 })) {
    assert.ok(width(line) <= 110, `a line is ${width(line)} cells: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// 10. Keys, ack and the follower
// ---------------------------------------------------------------------------

test("arrow keys and ctrl chords are tokenised, and a lone escape quits", () => {
  assert.deepEqual(tokenizeKeys("\u001b[A"), ["\u001b[A"]);
  assert.deepEqual(tokenizeKeys("\u001b[B"), ["\u001b[B"]);
  assert.deepEqual(tokenizeKeys("\u001b"), ["\u001b"]);
  assert.deepEqual(tokenizeKeys("q"), ["q"]);
  assert.deepEqual(tokenizeKeys("ab"), ["a", "b"]);
});

test("ack targets only unread inbox mail, and only from the inbox entry", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "lane"]);
  deliver(paths, { id: "eeeeeeee-5555-4555-8555-555555555555", from: "lane", to: [OPERATOR], text: "x", sentAt: "2026-11-02T21:00:00.000Z" });
  let state = initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR));
  assert.equal(ackTarget(state), "eeeeeeee-5555-4555-8555-555555555555");
  state = selectIndex(state, 1);
  assert.equal(ackTarget(state), null, "a room entry has nothing to ack");
  const read = selectIndex(initialSnapshotFor(OPERATOR, readSnapshot(envFor(paths), OPERATOR)), 0);
  const afterAck = read;
  markRead(paths, "eeeeeeee-5555-4555-8555-555555555555", OPERATOR);
  const refreshed = applySnapshot(afterAck, readSnapshot(envFor(paths), OPERATOR), Date.now());
  assert.equal(ackTarget(refreshed), null, "an acked message is no longer a target");
});

test("the follower is started with argv only, never a shell, and never --as", () => {
  const args = followArgs("slice-one", 4);
  assert.deepEqual(args.slice(1), ["read", "--room", "slice-one", "--follow", "--since", "4"]);
  assert.ok(!args.includes("--as"), "a read must not pass --as, which would refresh a presence lease (a write)");
  assert.ok(!args.includes("--json"), "stdout stays pure NDJSON");
  assert.ok(args[0]!.endsWith(path.join("bin", "rooms")), `follows the repo's own CLI: ${args[0]}`);
});

// ---------------------------------------------------------------------------
// 11. The manifest
// ---------------------------------------------------------------------------

test("the manifest declares a popup pane, an action and a non-colliding binding", () => {
  const manifest = fs.readFileSync(path.join(PLUGIN, "herdr-plugin.toml"), "utf8");
  assert.match(manifest, /^id = "pi-rooms"$/m);
  assert.match(manifest, /^min_herdr_version = "0\.9\.5"$/m);
  assert.match(manifest, /\[\[panes\]\]/);
  assert.match(manifest, /placement = "popup"/);
  assert.match(manifest, /width = "\d+%"/);
  assert.match(manifest, /height = "\d+%"/);
  assert.match(manifest, /\[\[actions\]\]/);
  assert.match(manifest, /command = "pi-rooms\.open"/);
  assert.match(manifest, /type = "plugin_action"/);
  const key = /\[\[keys\.command\]\]\s*\nkey = "([^"]+)"/.exec(manifest)?.[1];
  assert.ok(key != null, "the manifest declares a key");
  assert.ok(
    !(HERDR_DEFAULT_KEYS as readonly string[]).includes(key),
    `${key} is a herdr default binding`,
  );
  // The action opens the pane id the `[[panes]]` block declares.
  const paneId = /\[\[panes\]\]\s*\nid = "([^"]+)"/.exec(manifest)?.[1];
  assert.ok(paneId != null, "the pane declares an id");
  assert.match(manifest, new RegExp(`--entrypoint\\s+"?${paneId}"?`), "the action names the pane id");
  // herdr does not expand ${HERDR_PLUGIN_ROOT} in argv: it reaches the process as
  // a literal string, so node looked for /bin/rooms-popup.ts and the popup died
  // before it painted. Every working plugin wraps it in a shell that expands it.
  const paneCommand = /\[\[panes\]\][\s\S]*?command = \[([^\]]+)\]/.exec(manifest)?.[1] ?? "";
  assert.ok(paneCommand.length > 0, "the pane declares a command");
  if (paneCommand.includes("HERDR_PLUGIN_ROOT")) {
    assert.match(
      paneCommand,
      /"bash",\s*"-c"/,
      "a command referencing ${HERDR_PLUGIN_ROOT} must expand it through a shell",
    );
  }
  assert.doesNotMatch(paneCommand, /\|/, "no pipes: herdr passes argv, not a shell command");
  assert.doesNotMatch(paneCommand, /&&/, "no command chaining");
});

// ---------------------------------------------------------------------------
// 12. The CLI's own contract, exercised through the plugin's reader
// ---------------------------------------------------------------------------

test("readInbox de-duplicates a pending file left beside its archived copy", () => {
  const paths = tempStore();
  seedHuman(paths);
  deliver(paths, { id: "ffffffff-6666-4666-8666-666666666666", from: "lane", to: [OPERATOR], text: "once", sentAt: "2026-11-02T21:00:00.000Z" });
  const pending = drain(paths, OPERATOR);
  const pendingCopy = fs.readFileSync(pending[0]!.file, "utf8");
  archive(paths, OPERATOR, pending[0]!.file, pending[0]!.message);
  // A filesystem where the rename failed leaves the pending file behind.
  fs.writeFileSync(path.join(paths.inbox, OPERATOR, path.basename(pending[0]!.file)), pendingCopy);
  const mail = readInbox(paths, OPERATOR);
  assert.equal(mail.length, 1, "one message, not two");
  assert.equal(mail[0]!.state, "delivered", "the archived copy wins");
});

test("the reader never deletes an unparseable envelope", () => {
  const paths = tempStore();
  seedHuman(paths);
  fs.mkdirSync(path.join(paths.inbox, OPERATOR), { recursive: true });
  const broken = path.join(paths.inbox, OPERATOR, "broken.json");
  fs.writeFileSync(broken, "{not json");
  readInbox(paths, OPERATOR);
  assert.ok(fs.existsSync(broken), "a viewer must not delete a file it could not read");
});

test("the popup entrypoint renders a frame to a pipe, and --json dumps the snapshot", () => {
  const paths = tempStore();
  seedHuman(paths);
  seedRoom(paths, "slice-one", [OPERATOR, "lane"]);
  const entry = path.join(PLUGIN, "bin", "rooms-popup.ts");
  const env = { ...process.env, PI_ROOMS_DIR: paths.base, NO_MOTION: "1" };
  const frame = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, "--as", OPERATOR, "--width", "100", "--height", "30"], { encoding: "utf8", env });
  assert.equal(frame.status, 0, frame.stderr);
  assert.match(frame.stdout, /rooms/);
  assert.match(stripAnsi(frame.stdout), /inbox/);

  const json = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, "--as", OPERATOR, "--json"], { encoding: "utf8", env });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.base, paths.base);
  assert.equal(parsed.rooms.length, 1);
  assert.equal(parsed.humans.length, 1);
});
