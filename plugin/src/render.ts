/**
 * Rendering: state in, an array of screen lines out.
 *
 * Pure. No `process`, no clock of its own, no I/O — `render(state, opts)` with an
 * explicit `now` produces the same bytes twice, which is what makes the four
 * states and the motion rules testable instead of eyeballed.
 *
 * The visual grammar, all of it drawn from `theme.ts`:
 *
 *   one 1-cell marker column, then a fixed identifier cluster (time, seq,
 *   author), then prose. Every row type shares that gutter, so a long run reads
 *   as a column instead of a ragged shape.
 *
 *   delivery state and presence are **words** at a fixed column edge, never a
 *   filled dot: presence is a lease a human's own client wrote, not liveness.
 *
 *   rules for structure, colour only for state.
 */

import { COLOR, MOTION, SPACE, TYPE, sp, type ColorName } from "./theme.ts";
import { fit, pad, rule, style, width, wrap } from "./text.ts";
import {
  deliveryLabel,
  hasLiveArrivals,
  selectedEntry,
  type Entry,
  type MailRow,
  type Row,
  type State,
  type Stream,
} from "./model.ts";
import type { HumanRow } from "./reader.ts";

export interface RenderOpts {
  cols: number;
  rows: number;
  now: number;
  motion: boolean;
  tick: number;
}

/* ---- layout constants, all multiples of SPACE ---- */

/**
 * The identifier cluster's fixed columns, in order. Prose starts after these.
 *
 *   mark(1) pad(1) time(5) gap(1) ident(4,right) gap(1) author(N) pad(2)
 *
 * Every row type shares the cluster, so a long run reads as a column instead of
 * a ragged shape. `PROSE_OFFSET` is the sum of the fixed parts.
 */
const COL_MARK = 1;
const COL_PAD = 1;
const COL_TIME = 5;
const COL_IDENT = 4;
const COL_GAP = 1;
/** Air between the author and the prose, so a clipped name never touches a word. */
const PAD_PROSE = 2;
/** Air between prose and the right-hand state word. */
const PAD_STATE = 2;

const CLUSTER_FIXED = COL_MARK + COL_PAD + COL_TIME + COL_GAP + COL_IDENT + COL_GAP + PAD_PROSE;
/** The prose column starts at this cell of the main pane. */
const PROSE_OFFSET = sp(7);
const AUTHOR_CELLS = PROSE_OFFSET - CLUSTER_FIXED;
/** `delivered · copy` is the longest word pair a row carries. */
const STATE_COLUMN = 16;
/** A human's name, and its display label. */
const PRESENCE_NAME = sp(6);
/** `away · declared 23m ago` is the longest presence phrase. */
const PRESENCE_WORD = sp(6);

/** The rail: a name column plus a right-aligned count. */
export function railWidth(cols: number): number {
  if (cols >= 110) return sp(6);
  if (cols >= 90) return sp(4);
  return sp(3);
}

export function layout(cols: number): { rail: number; main: number; text: number } {
  const rail = Math.min(railWidth(cols), Math.max(sp(2), Math.floor(cols / 3)));
  const main = Math.max(0, cols - rail - 1);
  const text = Math.max(sp(2), main - PROSE_OFFSET - PAD_STATE - STATE_COLUMN);
  return { rail, main, text };
}

/* ---- the only two colour decisions in the plugin ---- */

export function stateColor(state: "queued" | "delivered" | "read" | "unknown"): ColorName {
  return state;
}

export function presenceColor(presence: "online" | "away" | "offline" | "unknown"): ColorName {
  return `presence_${presence}` as ColorName;
}

export function authorColor(author: string, ownName: string | null, humans: readonly HumanRow[]): ColorName {
  if (ownName != null && author === ownName) return "own";
  if (humans.some((h) => h.name === author)) return "human";
  return "agent";
}

export function render(state: State, opts: RenderOpts): string[] {
  const { cols, rows, now, motion, tick } = opts;
  const { rail, main, text } = layout(cols);
  const bodyRows = Math.max(1, rows - 4); // header, rule, footer rule, legend

  const lines: string[] = [];
  lines.push(...headerLines(state, cols));
  lines.push(...bodyLines(state, { cols, rail, main, text, bodyRows, now, motion, tick }));
  lines.push(style(rule(cols), "micro", "rule"));
  lines.push(...legendLines(state, cols));
  return lines;
}

/* ---- header ---- */

function headerLines(state: State, cols: number): string[] {
  const left = ` ${style("rooms", "display", "agent")}`;
  const who = state.identity ?? "no name";
  const rooms = state.snapshot.rooms.length;
  const unread = state.snapshot.inbox.filter((m) => m.state !== "read").length;
  const right =
    `${style(who, "body", "own")} ${style("·", "meta", "dim")} ` +
    `${style(`${rooms} room${rooms === 1 ? "" : "s"}`, "meta", "dim")} ${style("·", "meta", "dim")} ` +
    `${style(`${unread} no-readAt`, "meta", unread > 0 ? "unknown" : "dim")} `;
  const gap = Math.max(1, cols - width(left) - width(right));
  return [`${left}${" ".repeat(gap)}${right}`, ""];
}

/* ---- body: rail | main ---- */

interface Body {
  cols: number;
  rail: number;
  main: number;
  text: number;
  bodyRows: number;
  now: number;
  motion: boolean;
  tick: number;
}

function bodyLines(state: State, b: Body): string[] {
  const rail = railLines(state, b);
  const main = mainLines(state, b);
  const out: string[] = [];
  for (let i = 0; i < b.bodyRows; i += 1) {
    const railCell = pad(rail[i] ?? "", b.rail);
    const mainCell = main[i] ?? "";
    // The separator is coloured as structure, never as state.
    out.push(`${railCell}${style("│", "meta", "rule")}${mainCell}`);
  }
  return out;
}

function railLines(state: State, b: Body): string[] {
  const lines: string[] = [];
  let lastKind: Entry["kind"] | null = null;
  for (const [index, entry] of state.entries.entries()) {
    const selected = index === state.selection;
    if (entry.kind !== lastKind) {
      if (lastKind != null) lines.push(style(rule(b.rail), "micro", "rule"));
      lastKind = entry.kind;
    }
    const accent: ColorName = entry.kind === "room" ? "room" : entry.kind === "humans" ? "human" : "own";
    const marker = selected ? style("▌", "body", accent) : " ";
    const nameCells = Math.max(1, b.rail - sp(1) - 3);
    const name = fit(entry.label, nameCells);
    const count = entry.count > 0 ? String(entry.count) : "";
    const countColor: ColorName = entry.kind === "inbox" && entry.count > 0 ? "unknown" : "dim";
    lines.push(
      `${marker}${style(name, selected ? "title" : "body", selected ? accent : "dim")}` +
        `${style(fit(count, 3, "right"), "meta", countColor)}`,
    );
  }
  return lines;
}

function mainLines(state: State, b: Body): string[] {
  const entry = selectedEntry(state);
  const head = titleBlock(state, entry, b);
  const bodyCount = Math.max(1, b.bodyRows - head.length);
  return [...head, ...streamLines(state, b, bodyCount)];
}

function titleBlock(state: State, entry: Entry, b: Body): string[] {
  const lines: string[] = [];
  if (entry.kind === "inbox") {
    const count = state.snapshot.inbox.length;
    const noReadAt = state.snapshot.inbox.filter((m) => m.state !== "read").length;
    lines.push(
      `${style("inbox", "title", "own")}  ${style(
        `${count} message${count === 1 ? "" : "s"} · ${noReadAt} with no readAt · `
          + `this client stamps readAt only when you confirm an ack`,
        "meta",
        "dim",
      )}`,
    );
  } else if (entry.kind === "humans") {
    lines.push(
      `${style("humans", "title", "human")}  ${style(
        "a lease a human's own client wrote, expired on read — never liveness",
        "meta",
        "dim",
      )}`,
    );
  } else {
    const record = state.snapshot.rooms.find((r) => r.room.name === entry.key)?.room;
    const members = record?.members ?? [];
    const streamWord = state.stream.loading
      ? style("opening", "meta", "unknown")
      : style(
          state.stream.status === "error" ? "stopped" : "following",
          "meta",
          state.stream.status === "error" ? "error" : "delivered",
        );
    lines.push(
      `${style(entry.key, "title", "room")}  ${style(
        `${members.length} member${members.length === 1 ? "" : "s"} · ${entry.count} post${
          entry.count === 1 ? "" : "s"
        } · `,
        "meta",
        "dim",
      )}${streamWord}`,
    );
    if (members.length > 0) {
      lines.push(
        members
          .map((member) => style(member, "meta", authorColor(member, state.identity, state.snapshot.humans)))
          .join(style("  ", "meta", "dim")),
      );
    }
  }
  lines.push(style(rule(b.main), "micro", "rule"));
  return lines;
}

/* ---- the stream ---- */

function streamLines(state: State, b: Body, count: number): string[] {
  const entry = selectedEntry(state);
  if (entry.kind === "humans") return humanLines(state, b, count);

  const stream = state.stream;
  if (stream.rows.length === 0) {
    if (stream.status === "error") return errorBlock(state, b);
    if (stream.loading || stream.status === "loading") {
      return stateLines(b, [
        [
          "loading",
          "reading the store",
          `waiting for ${state.snapshot.base} · ${state.stream.cursor === 0 ? "the follower starts here" : `resuming at #${state.stream.cursor}`}`,
        ],
      ]);
    }
    return stateLines(b, [
      entry.kind === "inbox"
        ? ["empty", "no mail", "nobody has addressed this name; a DM or a room post will appear here"]
        : ["empty", "no posts", "the store has this room and its log holds no entries yet"],
    ]);
  }

  const flat: string[] = [];
  for (const row of stream.rows) flat.push(...rowLines(state, b, row));

  // Keep the newest visible unless the reader has scrolled back.
  const height = Math.max(1, count - 1);
  const maxOffset = Math.max(0, flat.length - height);
  const offset = Math.max(0, maxOffset - Math.min(state.scrollBack, maxOffset));
  const visible = flat.slice(offset, offset + height);

  const above = offset;
  const below = Math.max(0, flat.length - offset - visible.length);
  const scrollNote =
    above > 0 || below > 0
      ? [
          `${" ".repeat(sp(1))}${style(
            `${above > 0 ? `${above} line(s) above` : ""}${above > 0 && below > 0 ? " · " : ""}${
              below > 0 ? `${below} newer below` : ""
            }${below > 0 ? " · ctrl-d returns to newest" : ""}`,
            "micro",
            "dim",
          )}`,
        ]
      : [];
  return [...visible, ...scrollNote];
}

function rowLines(state: State, b: Body, row: Row): string[] {
  switch (row.kind) {
    case "post":
      return messageBlock(b, {
        time: clock(row.sentAt),
        ident: `#${row.seq}`,
        author: row.from,
        color: authorColor(row.from, state.identity, state.snapshot.humans),
        text: row.text,
        stateWord: null,
        stateColorName: "dim",
        arrivedAt: row.arrivedAt,
        markColor: authorColor(row.from, state.identity, state.snapshot.humans),
        footnote: null,
      });
    case "mail": {
      const item = row.item;
      return messageBlock(b, {
        time: clock(item.sentAt),
        ident: item.room != null ? `#${item.roomSeq ?? "?"}` : "dm",
        author: item.from,
        color: authorColor(item.from, state.identity, state.snapshot.humans),
        text: item.text,
        stateWord: deliveryLabel(item.state, item.witness),
        stateColorName: stateColor(item.state),
        arrivedAt: row.arrivedAt,
        markColor: stateColor(item.state),
        footnote:
          `${item.room != null ? `room ${item.room}` : "direct"}` +
          `${item.state === "delivered" && item.witness === "copy" ? " · the archived copy is the witness; the receipt lost deliveredAt" : ""}` +
          `${item.state === "unknown" ? " · no receipt stamp and no archived copy — unknown, not failed" : ""}` +
          `${item.state === "queued" ? " · a file is in the inbox; nothing has observed it" : ""}`,
      });
    }
    case "gap":
      return [
        `${style(rule(b.main), "meta", "gap")}`,
        `${" ".repeat(sp(1))}${style("gap", "title", "gap")} ${style(
          `${row.missed} post${row.missed === 1 ? "" : "s"} missing between #${row.after} and #${row.next}`,
          "meta",
          "gap",
        )}`,
        ...wrap(
          "the store skipped these numbers. Nothing here is invented or renumbered, and the next post keeps its own.",
          b.main - sp(2),
        ).map((line) => `${" ".repeat(sp(1))}${style(line, "micro", "dim")}`),
        `${style(rule(b.main), "meta", "gap")}`,
      ];
    case "notice":
      return [
        `${" ".repeat(COL_PAD)}${style(
          row.severity === "error" ? "✗" : "·",
          "title",
          row.severity === "error" ? "error" : "delivered",
        )} ${style(row.text, "title", row.severity === "error" ? "error" : "delivered")}`,
        ...(row.cause != null
          ? wrap(row.cause, Math.max(sp(2), b.main - sp(2))).map(
              (line) => `${" ".repeat(COL_PAD + 2)}${style(line, "meta", "dim")}`,
            )
          : []),
      ];
  }
}

interface BlockInput {
  time: string;
  ident: string;
  author: string;
  color: ColorName;
  text: string;
  stateWord: string | null;
  stateColorName: ColorName;
  arrivedAt: number | null;
  markColor: ColorName;
  footnote: string | null;
}

/**
 * One message.
 *
 * The arrival mark is the plugin's only motion: a block that shrinks to a
 * hairline and is gone inside {@link MOTION.arrivalTicks}, stamped once when the
 * row first appears. Under reduced motion the mark is dropped and the row is
 * simply present — same information, no movement.
 */
function messageBlock(b: Body, input: BlockInput): string[] {
  const cluster =
    fit(input.time, COL_TIME) +
    " ".repeat(COL_GAP) +
    fit(input.ident, COL_IDENT, "right") +
    " ".repeat(COL_GAP) +
    fit(input.author, AUTHOR_CELLS) +
    " ".repeat(PAD_PROSE);

  const out: string[] = [];
  for (const [index, line] of wrap(input.text, b.text).entries()) {
    const mark = index === 0 ? arrivalMark(input, b) : style("│", "meta", "rule");
    const ident = index === 0 ? cluster : " ".repeat(PROSE_OFFSET - COL_MARK - COL_PAD);
    const padded = pad(line, b.text);
    const stateCell =
      index === 0 && input.stateWord != null
        ? `${style(fit(input.stateWord, STATE_COLUMN, "right"), "meta", input.stateColorName)}`
        : " ".repeat(STATE_COLUMN);
    out.push(`${mark}${" ".repeat(COL_PAD)}${ident}${padded}${stateCell}`);
  }
  if (input.footnote != null && input.footnote.length > 0) {
    out.push(
      `${" ".repeat(COL_MARK + COL_PAD)}${style(
        fit(input.footnote, Math.max(sp(2), b.main - COL_MARK - COL_PAD), "left"),
        "micro",
        "dim",
      )}`,
    );
  }
  return out;
}

function arrivalMark(input: BlockInput, b: Body): string {
  if (!b.motion || input.arrivedAt == null) return style("▌", "body", input.markColor);
  const age = b.now - input.arrivedAt;
  const window = MOTION.arrivalTicks * MOTION.tickMs;
  if (age >= window) return style("▌", "body", input.markColor);
  const step = Math.floor(age / MOTION.tickMs);
  if (step < 1) return style("█", "body", input.markColor);
  if (step < 2) return style("▉", "body", input.markColor);
  if (step < 3) return style("▌", "body", input.markColor);
  if (step < 4) return style("▎", "meta", input.markColor);
  return style("▏", "meta", input.markColor);
}

/* ---- humans: same density as a room ---- */

function humanLines(state: State, b: Body, count: number): string[] {
  const humans = state.snapshot.humans;
  if (humans.length === 0) {
    return stateLines(b, [
      ["empty", "no humans", "no participant records in the store, so nobody to show"],
    ]);
  }
  const out: string[] = [];
  for (const human of humans.slice(0, Math.max(1, count - 1))) out.push(humanRow(human, state));
  return out;
}

function humanRow(human: HumanRow, state: State): string[] {
  const presence = human.presence;
  const word = presenceWord(presence.state, presence.ageMs);
  const names = human.displayName != null ? `${human.name} · ${human.displayName}` : human.name;
  const note =
    presence.present === false
      ? "nothing declared — an absent record is unknown, not offline"
      : presence.declared !== presence.state
        ? `declared ${presence.declared}; the clock derives ${presence.state}`
        : `declared ${presence.declared}${presence.client != null ? ` via ${presence.client}` : ""}`;
  const who =
    human.name === state.identity ? style(names, "body", "own") : style(names, "body", "human");
  return [
    `${style("▌", "body", presenceColor(presence.state))}${" ".repeat(COL_PAD)}` +
      `${fit(who, PRESENCE_NAME)}` +
      `${style(fit(word, PRESENCE_WORD), "title", presenceColor(presence.state))}` +
      `${style(note, "meta", "dim")}`,
  ];
}

/**
 * Presence as words carrying an age, never a dot.
 *
 * The age is attached to every state because §2.4's point is that a human's
 * state is a lease with a timestamp: "online" alone reads as "here now", which
 * is the claim the plan forbids.
 */
export function presenceWord(state: HumanRow["presence"]["state"], ageMs: number | null): string {
  return `${state} · ${ageMs == null ? "no lease" : `declared ${formatAge(ageMs)} ago`}`;
}

export function formatAge(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/* ---- the four states, designed rather than defaulted ---- */

type StateLine = [kind: "loading" | "empty" | "error" | "unknown", title: string, cause: string];

function stateLines(b: Body, entries: StateLine[]): string[] {
  const out: string[] = [];
  for (const [kind, title, cause] of entries) {
    const color: ColorName =
      kind === "error" ? "error" : kind === "unknown" ? "unknown" : kind === "loading" ? "queued" : "dim";
    const glyph = kind === "error" ? "✗" : kind === "unknown" ? "?" : kind === "loading" ? "·" : "○";
    out.push("");
    out.push(
      `${" ".repeat(sp(1))}${style(glyph, "title", color)} ${style(title, "title", color)} ` +
        `${style(`[${kind}]`, "micro", "dim")}`,
    );
    for (const line of wrap(cause, Math.max(sp(2), b.main - sp(3)))) {
      out.push(`${" ".repeat(sp(1) + 2)}${style(line, "meta", "dim")}`);
    }
  }
  out.push("");
  return out;
}

function errorBlock(state: State, b: Body): string[] {
  return stateLines(b, [
    [
      "error",
      state.stream.errorTitle ?? "the stream stopped",
      state.stream.errorCause ?? "no cause recorded",
    ],
  ]);
}

/* ---- footer ---- */

function legendLines(state: State, cols: number): string[] {
  if (state.pendingAck != null) {
    return [
      ` ${style("ack", "title", "unknown")} ${style(state.pendingAck.slice(0, 8), "body", "own")} ` +
        `${style("— y", "body", "delivered")}${style(" confirms, ", "meta", "dim")}` +
        `${style("n", "body", "error")}${style(" cancels. Confirming shells out to `rooms ack`, which is what writes readAt.", "meta", "dim")}`,
    ];
  }
  if (state.notice != null) {
    return [
      ` ${style(
        state.notice.severity === "error" ? "✗" : "·",
        "title",
        state.notice.severity === "error" ? "error" : "delivered",
      )} ${style(state.notice.text, "meta", state.notice.severity === "error" ? "error" : "dim")}`,
    ];
  }
  const keys: Array<[string, string]> = [
    ["↑↓", "select"],
    ["a", "ack"],
    ["ctrl-d/u", "scroll"],
    ["r", "re-read"],
    ["?", "help"],
    ["q", "quit"],
  ];
  const left = keys
    .map(([key, label]) => `${style(key, "body", "delivered")} ${style(label, "meta", "dim")}`)
    .join("  ");
  const statusColor: ColorName =
    state.stream.status === "error"
      ? "error"
      : state.stream.status === "live"
        ? "delivered"
        : state.stream.status === "unknown"
          ? "unknown"
          : "dim";
  const right =
    `${style(state.stream.loading ? "opening" : state.stream.status, "meta", statusColor)}` +
    `${state.stream.cursor > 0 ? style(` · #${state.stream.cursor}`, "meta", "dim") : ""} `;
  const gap = Math.max(1, cols - width(left) - width(right));
  return [` ${left}${" ".repeat(gap - 1)}${right}`];
}

/* ---- help ---- */

export function renderHelp(state: State, opts: RenderOpts): string[] {
  const { cols, rows, now } = opts;
  const lines: string[] = [
    ` ${style("rooms", "display", "agent")}  ${style("keys", "meta", "dim")}`,
    "",
  ];
  const entries: Array<[string, string]> = [
    ["↑ / ↓", "move between inbox, rooms and humans"],
    ["a", "acknowledge the newest unread message — shells out to `rooms ack`, the only writer of readAt"],
    ["y / n", "confirm or cancel a pending ack"],
    ["ctrl-d / ctrl-u", "scroll the stream"],
    ["r", "re-read the store and restart the follower"],
    ["?", "this panel"],
    ["q / esc", "close the popup, which kills the follower"],
  ];
  for (const [key, label] of entries) {
    lines.push(
      ` ${" ".repeat(sp(1))}${style(fit(key, sp(3)), "body", "delivered")}${style(label, "meta", "dim")}`,
    );
  }
  lines.push("");
  lines.push(
    ` ${style(
      "this client writes nothing: no inbox, no receipts, no room.json, no names.json.",
      "micro",
      "dim",
    )}`,
  );
  lines.push(` ${style(state.snapshot.base, "micro", "dim")}`);
  void cols;
  void now;
  return lines.slice(0, rows);
}

/* ---- helpers ---- */

function clock(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "--:--";
  const date = new Date(parsed);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Whether this frame still has an arrival to animate. Used by the motion tests. */
export function frameHasMotion(state: State, opts: RenderOpts): boolean {
  return opts.motion && hasLiveArrivals(state, opts.now, MOTION.arrivalTicks, MOTION.tickMs);
}

export type { Stream, MailRow };
export { style, SPACE, TYPE };