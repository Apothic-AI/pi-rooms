/**
 * The state machine behind the popup: what is selected, what the stream
 * contains, and how a follower line changes it.
 *
 * Kept apart from rendering and from I/O so every transition below is testable
 * without a terminal, a child process or a clock.
 *
 * The three rules this file enforces:
 *
 * 1. **A gap is content.** A `gap` line becomes a row that says how many posts
 *    are missing between which numbers. Nothing is resequenced, nothing is
 *    invented, and the posts after it keep the numbers the store gave them.
 * 2. **Arrival is a one-shot.** A row gets an arrival stamp at the moment it is
 *    first appended. Re-render, scroll and resize never move that stamp, so an
 *    old message can never look new. Rows already present at first paint get no
 *    stamp, which is why the follower's backlog does not animate.
 * 3. **Absence is a state, not an error.** Loading, empty, error and unknown are
 *    four different views, each carrying its own cause text. A pane that renders
 *    a failure as blank is indistinguishable from an empty room.
 */

import type { DeliveryState, MailItem, Snapshot } from "./reader.ts";

export type StreamStatus = "loading" | "live" | "empty" | "error" | "unknown";

export interface PostRow {
  kind: "post";
  id: string;
  seq: number;
  from: string;
  sentAt: string;
  text: string;
  own: boolean;
  /** Epoch ms this row first appeared in this popup, or null when it was already there. */
  arrivedAt: number | null;
}

export interface GapRow {
  kind: "gap";
  after: number;
  next: number;
  missed: number;
  arrivedAt: number | null;
}

export interface MailRow {
  kind: "mail";
  item: MailItem;
  index: number;
  arrivedAt: number | null;
}

export interface NoticeRow {
  kind: "notice";
  severity: "error" | "info";
  text: string;
  cause: string | null;
  arrivedAt: number | null;
}

export type Row = PostRow | GapRow | MailRow | NoticeRow;

export interface Stream {
  status: StreamStatus;
  rows: Row[];
  /** Highest seq rendered, which is the honest resume point after a gap. */
  cursor: number;
  /** Named failure: what died, not just that something did. */
  errorTitle: string | null;
  errorCause: string | null;
  /** True until the follower's first line or its first quiet moment. */
  loading: boolean;
}

export type EntryKind = "inbox" | "room" | "humans";

export interface Entry {
  kind: EntryKind;
  key: string;
  label: string;
  /** Posts for a room, unacked mail for the inbox, participants for humans. */
  count: number;
}

export interface State {
  identity: string | null;
  snapshot: Snapshot;
  selection: number;
  entries: Entry[];
  stream: Stream;
  /** Lines the reader has scrolled back from the bottom. 0 means pinned to newest. */
  scrollBack: number;
  /** Set while an ack is waiting for its y/n confirmation. This is staging, not writing. */
  pendingAck: string | null;
  /** Last local notice, e.g. the result of an ack. */
  notice: { severity: "error" | "info"; text: string } | null;
  help: boolean;
  /** Row keys already rendered, so an arrival stamp is assigned exactly once. */
  seen: Set<string>;
}

export function emptyStream(status: StreamStatus = "loading"): Stream {
  return { status, rows: [], cursor: 0, errorTitle: null, errorCause: null, loading: status === "loading" };
}

export function entriesFor(snapshot: Snapshot, identity: string | null): Entry[] {
  const unacked = identity == null ? 0 : snapshot.inbox.filter((m) => m.state !== "read").length;
  return [
    { kind: "inbox", key: "inbox", label: "inbox", count: unacked },
    ...snapshot.rooms.map(({ room, posts }) => ({
      kind: "room" as const,
      key: room.name,
      label: room.name,
      count: posts,
    })),
    { kind: "humans", key: "humans", label: "humans", count: snapshot.humans.length },
  ];
}

/**
 * The first state, with the inbox already built.
 *
 * The inbox stream is a pure function of the snapshot, so it is safe to build
 * before any child exists — and a popup that opens on an empty inbox shows
 * "no mail" rather than a spinner that never resolves.
 */
export function initialSnapshotFor(identity: string | null, snapshot: Snapshot, now = Date.now()): State {
  const state = initialState(identity, snapshot);
  return { ...state, stream: inboxStream(state, now) };
}

export function initialState(identity: string | null, snapshot: Snapshot): State {
  return {
    identity,
    snapshot,
    selection: 0,
    entries: entriesFor(snapshot, identity),
    stream: emptyStream("loading"),
    scrollBack: 0,
    pendingAck: null,
    notice: null,
    help: false,
    seen: new Set<string>(),
  };
}

/** True while a freshly arrived row still has motion left to show. */
export function hasLiveArrivals(state: State, now: number, ticks: number, tickMs: number): boolean {
  const window = ticks * tickMs;
  if (window <= 0) return false;
  return state.stream.rows.some((row) => row.arrivedAt != null && now - row.arrivedAt < window);
}

export function selectedEntry(state: State): Entry {
  return state.entries[state.selection] ?? state.entries[0]!;
}

/**
 * Replace the static snapshot, keeping selection and any room stream.
 *
 * The inbox view is rebuilt from the snapshot; a room view is not, because its
 * rows come from the follower and re-reading the log here would duplicate them.
 */
export function applySnapshot(state: State, snapshot: Snapshot, now: number): State {
  const next: State = { ...state, snapshot, entries: entriesFor(snapshot, state.identity) };
  if (next.selection >= next.entries.length) next.selection = Math.max(0, next.entries.length - 1);
  if (selectedEntry(next).kind === "inbox") next.stream = inboxStream(next, now);
  return next;
}

export function moveSelection(state: State, delta: number): State {
  if (state.entries.length === 0) return state;
  const count = state.entries.length;
  const selection = (((state.selection + delta) % count) + count) % count;
  return { ...state, selection, scrollBack: 0, pendingAck: null };
}

export function selectIndex(state: State, index: number): State {
  if (index < 0 || index >= state.entries.length) return state;
  return { ...state, selection: index, scrollBack: 0, pendingAck: null };
}

/**
 * The inbox view: the human's own mail, oldest first, from the snapshot.
 *
 * Nothing is stamped here. `readAt` is written only by `rooms ack`, on an
 * explicit keypress, because it is the one claim this run exists to keep honest:
 * a screen showed these bytes.
 */
export function inboxStream(state: State, now: number): Stream {
  if (state.identity == null) {
    return {
      status: "unknown",
      rows: [
        {
          kind: "notice",
          severity: "info",
          text: "no human name declared",
          cause:
            "start the popup with --as NAME (or set PI_ROOMS_AS) so the client knows whose mail to show. "
            + "Without a name it shows rooms only, and it will not guess: a guess that lands on a lane's "
            + "name would show that lane's mail.",
          arrivedAt: null,
        },
      ],
      cursor: 0,
      errorTitle: null,
      errorCause: null,
      loading: false,
    };
  }
  const rows: Row[] = state.snapshot.inbox.map((item, index) => {
    const key = mailKey(item);
    const arrivedAt = state.seen.has(key) ? null : now;
    if (arrivedAt != null) state.seen.add(key);
    return { kind: "mail", item, index, arrivedAt } as MailRow;
  });  return {
    status: rows.length === 0 ? "empty" : "live",
    rows,
    cursor: 0,
    errorTitle: null,
    errorCause: null,
    loading: false,
  };
}

export function mailKey(item: MailItem): string {
  return `mail:${item.id}`;
}

/**
 * Apply one NDJSON line from `rooms read --follow`.
 *
 * An `{ok:false}` line is the CLI reporting a refusal (an unknown room, a bad
 * flag). It is surfaced as a failure rather than ignored: "the room does not
 * exist" and "the room is empty" must not look the same.
 *
 * Unknown `type` values are ignored rather than rendered, so a newer follower
 * that adds a line kind cannot put garbage into a human's stream.
 */
export function applyFollowEvent(
  state: State,
  event: Record<string, unknown>,
  now: number,
  ownName: string | null,
): State {
  if (event.ok === false) {
    const message = typeof event.error === "string" ? event.error : "the follower refused";
    return failStream(state, "the follower refused", message, now);
  }
  const type = event.type;
  if (type === "post") {
    const seq = typeof event.seq === "number" ? event.seq : null;
    if (seq == null) return state;
    const id = typeof event.id === "string" ? event.id : "";
    const key = `post:${seq}:${id}`;
    // A follower restart replays the backlog. The row is already on screen, and
    // appending it again would duplicate a message the human has read.
    if (state.seen.has(key)) return state;
    state.seen.add(key);
    const row: PostRow = {
      kind: "post",
      id,
      seq,
      from: typeof event.from === "string" ? event.from : "(unknown)",
      sentAt: typeof event.sentAt === "string" ? event.sentAt : "",
      text: typeof event.text === "string" ? event.text : "",
      own: ownName != null && event.from === ownName,
      arrivedAt: now,
    };
    return {
      ...state,
      stream: {
        ...state.stream,
        status: "live",
        loading: false,
        rows: [...state.stream.rows, row],
        cursor: Math.max(state.stream.cursor, seq),
      },
    };
  }
  if (type === "gap") {
    const after = typeof event.after === "number" ? event.after : state.stream.cursor;
    const next = typeof event.next === "number" ? event.next : after + 1;
    const missed = typeof event.missed === "number" ? event.missed : Math.max(0, next - after - 1);
    const row: GapRow = { kind: "gap", after, next, missed, arrivedAt: now };
    return {
      ...state,
      stream: {
        ...state.stream,
        status: "live",
        loading: false,
        rows: [...state.stream.rows, row],
        // The cursor deliberately stays behind the gap: it is the honest resume
        // point, and moving it past the loss would hide it on a restart.
        cursor: Math.max(state.stream.cursor, after),
      },
    };
  }
  return state;
}

/**
 * The follower died. Name the failure; never blank the pane.
 *
 * The rows already rendered stay on screen: a reader who saw four messages and
 * is then told the stream stopped should still be able to read the four.
 */
export function failStream(state: State, title: string, cause: string, now: number): State {
  const rows = [...state.stream.rows];
  const last = rows[rows.length - 1];
  const duplicate = last?.kind === "notice" && last.text === title && last.cause === cause;
  if (!duplicate) rows.push({ kind: "notice", severity: "error", text: title, cause, arrivedAt: now });
  return {
    ...state,
    stream: { ...state.stream, status: "error", loading: false, rows, errorTitle: title, errorCause: cause },
  };
}

/** The follower's first quiet moment: it is running, so "loading" is over. */
export function markLive(state: State): State {
  if (!state.stream.loading) return state;
  return {
    ...state,
    stream: {
      ...state.stream,
      loading: false,
      status: state.stream.rows.length === 0 ? "empty" : state.stream.status,
    },
  };
}

/** A room stream that has not produced its first line yet. */
export function loadingRoom(): Stream {
  return emptyStream("loading");
}

export function setNotice(state: State, severity: "error" | "info", text: string): State {
  return { ...state, notice: { severity, text } };
}

/**
 * The delivery word for a message, and the evidence behind it.
 *
 * Each state carries its witness because "delivered" from a receipt stamp and
 * "delivered" from the archived copy are different facts — the copy is what
 * survives a receipt that lost `deliveredAt`, and a reader should be able to see
 * which one they are looking at.
 */
export function deliveryLabel(state: DeliveryState, witness: "receipt" | "copy" | null): string {
  switch (state) {
    case "read":
      return "read";
    case "delivered":
      return witness === "copy" ? "delivered · copy" : "delivered";
    case "queued":
      return "queued";
    default:
      return "unknown";
  }
}

/** The id an `a` keypress would acknowledge, for the entry under the cursor. */
export function ackTarget(state: State): string | null {
  const entry = selectedEntry(state);
  if (entry.kind !== "inbox") return null;
  const mail = state.stream.rows.filter((row): row is MailRow => row.kind === "mail");
  if (mail.length === 0) return null;
  // The newest unacked one: the row a reader is looking at the bottom of.
  const unacked = mail.filter((row) => row.item.state !== "read");
  if (unacked.length === 0) return null;
  return unacked[unacked.length - 1]!.item.id;
}

export function scrollBy(state: State, delta: number): State {
  return { ...state, scrollBack: Math.max(0, state.scrollBack + delta) };
}
