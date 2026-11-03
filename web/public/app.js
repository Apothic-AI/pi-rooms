/**
 * The pi-rooms web reader — a SolidJS client over one loopback SSE relay.
 *
 * This client is a *reader*. It renders bytes the store already contains and
 * derives nothing the store did not record: no `queuedAt`, no `deliveredAt`, no
 * `readAt`, no `roomSeq`, no liveness, no name suffixes. The receipt ladder it
 * displays comes from `web/server/receipts.ts`, which reads the receipt file and
 * its `read/` witness; this file only colours what it is told.
 *
 * Two rules from the brief are load-bearing here and easy to get wrong:
 *
 *   1. An absent `deliveredAt` is **unknown**, never "not delivered" (§5.3). The
 *      ladder's weakest rung is `unknown`, and `unknown` is styled as the absence
 *      of a claim — ink at its faintest, dotted — never as a failure.
 *   2. No `readAt` is ever written. `ack` is the operator's act in a terminal;
 *      "a screen showed these bytes" is a claim only the renderer may make *on
 *      the human's instruction*, not on a repaint. This client makes no request
 *      that could stamp one, and it has no route that could.
 *
 * ## Why hyperscript and not the `html` tag
 *
 * `solid-js/html` is smaller to read, but it compiles each template with
 * `new Function`, and this server sends `script-src 'self'` with no
 * `'unsafe-eval'`. That combination renders a blank page — which is exactly the
 * failure criterion 5 forbids, produced by the framework rather than by the
 * design. The fix is not to weaken the CSP: a read-only reader that needs
 * `unsafe-eval` to display a message log is a reader that has already given up
 * something it did not have to. `solid-js/h` builds the same DOM through
 * `document.createElement` and needs no eval at all, so the policy stays strict
 * and the bundle has no `new Function` in it. A test asserts both.
 */

import { createSignal, createMemo, For, Show, createRoot, onCleanup } from './vendor/solid.js';
import { render } from './vendor/solid-web.js';
import h from './vendor/h.js';

/* ── Small helpers ──────────────────────────────────────────────────────── */

/**
 * A keyed list: `<For>` with a *getter* for `each`.
 *
 * This is not a stylistic choice. Wrapping `For` in a function (`() => For(...)`)
 * re-creates the whole list on every append, so every existing row is rebuilt and
 * its arrival animation replays — an old message looking new, which criterion 3
 * calls worse than no motion at all. With the getter form, Solid reconciles by
 * identity and an existing row keeps its DOM node.
 */
const Each = (items, row) => h(For, { get each() { return items(); }, children: row });

/**
 * `<Show>` with an accessor condition.
 *
 * `children` is passed straight through, so a caller can hand either an element
 * or a zero-argument function; Solid treats the latter as a reactive child.
 */
const show = (accessor, children, fallback) =>
  h(Show, { get when() { return accessor(); }, children, fallback });

const EMPTY = Object.freeze([]);

function hhmm(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return '--:--';
  return iso.slice(11, 16);
}

/** "declared 23m ago" — a lease's age, never a claim of presence. */
function ageWords(ageMs) {
  if (ageMs == null) return 'never declared';
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return `declared ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `declared ${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `declared ${hr}h ago`;
  return `declared ${Math.floor(hr / 24)}d ago`;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const message = body?.error?.message ?? `${url} answered ${res.status}`;
    const kind = body?.error?.kind ?? 'http';
    throw Object.assign(new Error(message), { kind, status: res.status });
  }
  return body;
}

/* ── Receipt ladder rendering (criterion 4) ─────────────────────────────── */

/**
 * One recipient's rung. The *word* is always present, so the state survives a
 * greyscale print, colour blindness, or a CSS failure — colour is a second
 * channel, never the only one. A `*` marks the rung whose evidence came from the
 * inbox copy rather than the receipt, so the §5.3 recovery is visible instead of
 * being silently smoothed over.
 */
function Rung(delivery) {
  const props = { class: `receipt receipt--${delivery.state}` };
  if (delivery.state === 'unknown') {
    props.title = 'no receipt and no inbox copy: nothing was claimed either way';
  } else if (delivery.state === 'delivered' && delivery.witness === 'read-copy') {
    // The asterisk is not ornament: it says the rung was recovered from the
    // inbox copy rather than the receipt, which is §5.3's witness rule showing
    // its work instead of hiding it.
    props.title = 'the receipt had lost its deliveredAt; the inbox copy is the witness';
  }
  const mark = delivery.state === 'delivered' && delivery.witness === 'read-copy' ? '*' : '';
  return h('span', props,
    h('span', { class: 'receipt__who' }, delivery.recipient),
    h('span', { class: 'receipt__state' }, delivery.state + mark),
  );
}

function Ladder(deliveries) {
  return h('div', { class: 'receipts' },
    h('span', { class: 'receipts__label' }, 'receipts'),
    Each(deliveries, (delivery) => Rung(delivery)),
  );
}

/* ── A log row ──────────────────────────────────────────────────────────── */

/**
 * `arrive` is decided once, when the row object is created, and never changes.
 * That is what keeps the animation from replaying: the class is a static string
 * baked into the element at creation, and `<For>` is keyed, so an existing row is
 * never re-created. A row that loaded from history is created with
 * `arrive: false` and therefore never animates at all.
 */
function rowClass(post) {
  return [
    'row',
    post.from === post._me ? 'row--own' : '',
    post._arrive ? 'row--arrive' : '',
  ].filter(Boolean).join(' ');
}

function Row(p) {
  const post = p.post;
  // An inbox envelope has no room position — `seq` is the room log's numbering,
  // and inventing one for a DM would be the reader computing `roomSeq`, which the
  // brief forbids. So the gutter shows a position only when the store gave one,
  // and the element id falls back to the message id it already has.
  const seq = typeof post.seq === 'number' ? post.seq : null;
  const elementId = post.id != null ? `m-${post.id}` : seq != null ? `m-${seq}` : undefined;
  return h('li', {
    class: rowClass(post),
    id: elementId,
    'data-seq': seq == null ? undefined : seq,
  },
    h('div', { class: 'row__gutter' },
      seq == null ? null : h('span', { class: 'row__seq' }, `#${seq}`),
      h('span', { class: 'row__time' }, hhmm(post.sentAt)),
    ),
    h('div', { class: 'row__body' },
      h('div', { class: 'row__head' },
        h('span', { class: 'row__author' }, post.from),
        show(() => post.from === p.me, h('span', { class: 'row__you' }, 'you')),
        show(
          () => post.via != null && post.via.length > 0,
          h('span', { class: 'row__via', title: 'self-declared, never validated' }, post.via == null ? '' : post.via),
        ),
        show(
          () => post.room != null && post.roomSeq != null,
          h('span', { class: 'row__room' }, `${post.room == null ? '' : post.room} #${post.roomSeq}`),
        ),
        // In the inbox, a message with no room is a true DM and says so; one
        // with a room keeps its room tag above. The two are different things and
        // the reader must not have to infer which from an absence.
        show(
          () => p.context === 'inbox' && (post.room == null || post.roomSeq == null),
          h('span', { class: 'row__dm' }, 'dm'),
        ),
      ),
      h('p', { class: 'row__text' }, post.text),
      show(() => p.deliveries().length > 0, () => Ladder(p.deliveries)),
      show(() => post.id != null, h('div', { class: 'row__id' }, post.id == null ? '' : post.id)),
    ),
  );
}

/**
 * A gap is rendered as itself, in the stream's own words. A reader that closed a
 * gap quietly would be inventing history that was never written (§4, §5.4).
 */
function Gap(gap) {
  return h('li', { class: 'gap' },
    h('div', { class: 'gap__mark' }, 'gap'),
    h('div', { class: 'gap__body' },
      gap.note,
      h('span', { class: 'gap__detail' }, `after #${gap.after} · next #${gap.next} · ${gap.missed} missing`),
    ),
  );
}

/* ── States (criterion 5) ───────────────────────────────────────────────── */

function Loading() {
  const skeleton = () => h('div', { class: 'skeleton' },
    h('div', { class: 'skeleton__gutter' }),
    h('div', null,
      h('div', { class: 'skeleton__line' }),
      h('div', { class: 'skeleton__line' }),
    ),
  );
  return h('div', { class: 'state', 'aria-busy': 'true', 'aria-live': 'polite' },
    h('p', { class: 'state__kicker' }, 'loading'),
    skeleton(), skeleton(), skeleton(),
  );
}

function Empty(p) {
  return h('div', { class: 'state state--empty' },
    h('p', { class: 'state__kicker' }, 'empty'),
    h('h2', { class: 'state__title' }, p.title),
    h('p', { class: 'state__body' }, p.body),
    h('p', { class: 'state__hint' }, p.hint),
  );
}

/**
 * Error. Criterion 5 forbids a blank pane that could be an empty room, so this
 * always names *which* failure — kicker, title and body are three distinct
 * fields — and prints the writer's own output verbatim in a fourth.
 */
function ErrorState(p) {
  return h('div', { class: 'state state--error', role: 'alert' },
    h('p', { class: 'state__kicker' }, p.kicker == null ? 'error' : p.kicker),
    h('h2', { class: 'state__title' }, p.title),
    h('p', { class: 'state__body' }, p.body),
    show(() => p.detail != null && String(p.detail).length > 0, h('pre', { class: 'state__hint' }, p.detail)),
  );
}

/* ── Roster: participants, presence as a lease ──────────────────────────── */

function PresenceRow(presence) {
  const view = presence == null ? { state: 'unknown', ageMs: null } : presence;
  return h('div', { class: `presence presence--${view.state}` },
    h('span', { class: 'ring', 'aria-hidden': 'true' }),
    h('span', { class: 'presence__word' }, view.state),
    h('span', { class: 'presence__age' }, ageWords(view.ageMs)),
  );
}

function RosterItem(entry) {
  const participant = entry.participant;
  return h('li', { class: 'roster__item' },
    h('span', { class: 'roster__name' }, participant.name),
    show(
      () => participant.displayName != null && participant.displayName.length > 0,
      h('span', { class: 'roster__display' }, participant.displayName == null ? '' : participant.displayName),
    ),
    h('span', { class: 'roster__kind' }, participant.kind),
    PresenceRow(entry.presence),
  );
}

/* ── The app ────────────────────────────────────────────────────────────── */

createRoot(() => {
  const [config, setConfig] = createSignal(null);
  const [rooms, setRooms] = createSignal(EMPTY);
  const [roster, setRoster] = createSignal(EMPTY);
  /**
   * `idle` | `loading` | `ready` | `failed` for the roster alone.
   *
   * The panel needs this because "no participants" and "not read yet" are
   * different statements, and only one of them is a claim about the store. The
   * screenshot that caught it showed a working store with four participants
   * while the panel said none existed — because the roster loads without
   * blocking the log, and the empty rendering was reached first.
   */
  const [rosterState, setRosterState] = createSignal('idle');
  const [inbox, setInbox] = createSignal(EMPTY);
  const [inboxError, setInboxError] = createSignal(null);

  /** Which conversation is open: `{kind:'room', name}` or `{kind:'inbox'}`. */
  const [selected, setSelected] = createSignal(null);

  /** The open conversation's rows. Replaced wholesale when the room changes. */
  const [rows, setRows] = createSignal(EMPTY);
  /** Receipt ladders, keyed by message id. Sampled at load and at arrival. */
  const [ladders, setLadders] = createSignal({});
  /** `idle` | `loading` | `live` | `down` | `error` */
  const [phase, setPhase] = createSignal('idle');
  const [failure, setFailure] = createSignal(null);
  /** The browser's own cursor. The relay never holds it, so a reconnect resumes. */
  const [cursor, setCursor] = createSignal(0);
  const [roomMeta, setRoomMeta] = createSignal(null);

  const me = () => config()?.me ?? null;
  const isRoom = () => selected()?.kind === 'room';
  const openRoom = () => (isRoom() ? selected().name : null);

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  async function boot() {
    try {
      const cfg = await getJson('/api/config');
      setConfig(cfg);
      const list = await getJson('/api/rooms');
      setRooms(list.rooms ?? []);
      void loadRoster();
      if (cfg.me != null) void loadInbox();
      // Which room opens is a display choice, made among rooms the store already
      // listed — it derives nothing about the protocol. Prefer a room with posts:
      // landing on an empty room makes a working store look like a broken one,
      // and the alphabetical first room happens to be the quiet one often enough
      // that this is worth deciding rather than inheriting. Falls back to the
      // first room, then to the inbox.
      const list2 = list.rooms ?? [];
      const opening = list2.find((room) => room.posts > 0) ?? list2[0];
      if (opening != null) void selectRoom(opening.name);
      else if (cfg.me != null) selectInbox();
    } catch (error) {
      setPhase('error');
      setFailure({
        kind: error.kind ?? 'http',
        title: 'The reader could not reach the store.',
        body: 'The loopback relay answered, but reading the store through it failed. This is not an empty room.',
        detail: error.message,
      });
    }
  }

  async function loadRoster() {
    setRosterState('loading');
    try {
      const data = await getJson('/api/participants');
      const byName = new Map((data.presence ?? []).map((p) => [p.name, p]));
      setRoster((data.participants ?? []).map((participant) => ({
        participant,
        presence: byName.get(participant.name) ?? null,
      })));
      setRosterState('ready');
    } catch {
      // The roster is a side panel, so a failure here must not take the log
      // down — but it must not claim the store is empty either. `failed` says
      // the panel could not be read, which is a statement about this reader.
      setRoster(EMPTY);
      setRosterState('failed');
    }
  }

  async function loadInbox() {
    try {
      const data = await getJson('/api/inbox');
      setInbox(data.messages ?? []);
      const map = {};
      for (const [id, deliveries] of Object.entries(data.receipts ?? {})) map[id] = deliveries;
      setLadders((prev) => ({ ...prev, ...map }));
      setInboxError(null);
    } catch (error) {
      setInboxError({
        kind: error.kind ?? 'http',
        title: 'Your inbox could not be read.',
        body: 'DMs are unknown, not empty.',
        detail: error.message,
      });
      setInbox(EMPTY);
    }
  }

  /* ── The stream ───────────────────────────────────────────────────────── */

  let source = null;

  function closeStream() {
    if (source != null) {
      source.close();
      source = null;
    }
  }

  function appendPost(post) {
    setRows((prev) => {
      if (prev.some((r) => r._kind === 'post' && r.seq === post.seq)) return prev;
      // The single place a row is created as an arrival. `_arrive: true` is set
      // here and nowhere else, so the animation has exactly one trigger.
      return [...prev, { ...post, _kind: 'post', _me: me(), _arrive: true }];
    });
    setCursor(post.seq);
  }

  function openStream(room, since) {
    closeStream();
    setPhase('loading');
    setFailure(null);

    const es = new EventSource(`/api/rooms/${encodeURIComponent(room)}/stream?since=${since}`);
    source = es;

    es.addEventListener('relay', (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.phase === 'hello') {
        setPhase('live');
      } else if (frame.phase === 'end') {
        if (frame.ok === true) {
          setPhase('idle');
        } else {
          // The writer exited non-zero. Say *which* failure, with its stderr.
          setPhase('error');
          setFailure({
            kind: 'writer',
            title: 'The writer stopped following this room.',
            body: `\`bin/rooms read --follow\` exited ${frame.code == null ? 'on signal ' + frame.signal : frame.code}. History below is what it delivered before it stopped; nothing after that is known.`,
            detail: frame.stderr,
          });
        }
      }
    });

    es.addEventListener('rooms', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        // A frame that is not JSON is a relay bug, not a message. Saying so is
        // better than dropping it silently.
        setPhase('error');
        setFailure({
          kind: 'protocol',
          title: 'The stream sent something that is not a protocol line.',
          body: 'The relay forwarded a line that does not parse. This is a reader bug, not a store state.',
          detail: String(event.data).slice(0, 400),
        });
        return;
      }
      if (message.type === 'gap') {
        setRows((prev) => [...prev, { ...message, _kind: 'gap' }]);
        return;
      }
      if (message.type === 'post') appendPost(message);
    });

    es.addEventListener('receipts', (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (typeof frame.id !== 'string') return;
      setLadders((prev) => ({ ...prev, [frame.id]: frame.deliveries ?? [] }));
    });

    es.onerror = () => {
      // An EventSource reconnects on its own. The relay is stateless, so the
      // browser re-opens with its own `since` and no history is invented or
      // replayed; this only reports the gap in the pipe.
      setPhase('down');
    };
  }

  /* ── Selection ────────────────────────────────────────────────────────── */

  async function selectRoom(name) {
    setSelected({ kind: 'room', name });
    setRows(EMPTY);
    setLadders({});
    setRoomMeta(null);
    setPhase('loading');
    setFailure(null);
    setCursor(0);

    try {
      const data = await getJson(`/api/rooms/${encodeURIComponent(name)}`);
      // History is rendered as "already there": `_arrive: false` means no row
      // loaded from disk ever animates. Only a live `post` sets it true.
      const posts = (data.posts ?? []).map((post) => ({
        ...post, _kind: 'post', _me: me(), _arrive: false,
      }));
      setRows(posts);
      const lastSeq = posts.length > 0 ? posts[posts.length - 1].seq : 0;
      setCursor(lastSeq);
      setRoomMeta(data.room ?? null);
      const map = {};
      for (const [id, deliveries] of Object.entries(data.receipts ?? {})) map[id] = deliveries;
      setLadders(map);
      openStream(name, lastSeq);
    } catch (error) {
      setPhase('error');
      setFailure({
        kind: error.kind ?? 'http',
        title: `Room ${name} could not be read.`,
        body: 'The store answered with an error. This is not an empty room — an empty room renders with its own state.',
        detail: error.message,
      });
    }
  }

  function selectInbox() {
    setSelected({ kind: 'inbox' });
    closeStream();
    setPhase('idle');
    setFailure(null);
    setRows(EMPTY);
    void loadInbox();
  }

  function refresh() {
    if (isRoom()) void selectRoom(openRoom());
    else {
      void loadInbox();
      void loadRoster();
    }
  }

  onCleanup(closeStream);

  /* ── Derived views ────────────────────────────────────────────────────── */

  /**
   * The rows on screen.
   *
   * A memo, not a plain function, and that is the point: `<For>` reconciles by
   * item identity, so returning freshly-built objects on every read would make
   * every row a new item and rebuild the whole list — the replay bug again,
   * arriving through a different door. The memo returns the same objects until
   * the underlying source actually changes.
   */
  const visibleRows = createMemo(() =>
    isRoom()
      ? rows()
      : inbox().map((m) => ({ ...m, _kind: 'post', _me: me(), _arrive: false })));

  const deliveriesFor = (id) => () => ladders()[id] ?? EMPTY;

  /**
   * The header's title.
   *
   * A placeholder before the first selection is deliberate: claiming "Your inbox"
   * while nothing is open is a false statement about what the reader is showing,
   * and it is the kind of falsehood a screenshot makes obvious and a source scan
   * never would.
   */
  const title = () => {
    const sel = selected();
    if (sel == null) return 'rooms';
    if (sel.kind === 'room') return sel.name;
    return me() != null ? 'Your inbox' : 'Inbox';
  };

  const streamWords = () => {
    switch (phase()) {
      case 'live': return { cls: 'stream stream--live', word: 'following' };
      case 'loading': return { cls: 'stream stream--idle', word: 'connecting' };
      case 'down': return { cls: 'stream stream--down', word: 'reconnecting' };
      case 'error': return { cls: 'stream stream--down', word: 'stopped' };
      default: return { cls: 'stream stream--idle', word: 'not streaming' };
    }
  };

  /**
   * The state block that stands beside the log, or `null` when the list is the
   * thing to show.
   *
   * Returning `null` rather than an empty element matters: the caller keeps the
   * list mounted at all times and toggles a class, so a state change never
   * unmounts a row and never replays its arrival.
   */
  function stateBlock() {
    if (phase() === 'error' && failure() != null) {
      return ErrorState(failure());
    }
    if (phase() === 'loading' && rows().length === 0) {
      return Loading();
    }
    if (isRoom() && rows().length === 0) {
      return Empty({
        title: `No posts in ${openRoom()} yet.`,
        body: 'The room exists and this reader is following it. A post written in a terminal with `bin/rooms post` arrives here as it lands.',
        hint: `bin/rooms post --room ${openRoom()} --as ${me() ?? 'NAME'} "…"`,
      });
    }
    if (!isRoom() && me() == null) {
      return Empty({
        title: 'No inbox identity.',
        body: 'This reader was started without --me NAME, so it cannot know whose inbox to show. Rooms still render.',
        hint: 'npm run web -- --me operator',
      });
    }
    if (!isRoom() && inbox().length === 0) {
      if (inboxError() != null) return ErrorState(inboxError());
      return Empty({
        title: 'No mail in your inbox.',
        body: 'Nothing has been delivered to this name. An empty inbox is a real state, not an error.',
        hint: "bin/rooms dm --to NAME --as SOMEONE '…'",
      });
    }
    return null;
  }

  /* ── The view ─────────────────────────────────────────────────────────── */

  const rail = () => h('nav', { class: 'rail', 'aria-label': 'Conversations' },
    h('span', { class: 'wordmark' }, 'rooms', h('span', { class: 'wordmark__dot' }, '.')),
    h('span', { class: 'wordmark__sub' }, () => (me() == null ? 'no identity' : me())),
    h('span', { class: 'readonly', title: 'GET only. No write verb is reachable from this process.' },
      h('span', { class: 'ring', 'aria-hidden': 'true' }),
      'read-only reader',
    ),

    h('div', { class: 'rail__section' },
      h('h2', { class: 'rail__head' },
        h('span', null, 'rooms'),
        h('span', { class: 'rail__count' }, () => String(rooms().length)),
      ),
      show(
        () => rooms().length > 0,
        () => h('ul', { class: 'rail__list' },
          Each(rooms, (room) => h('li', null,
            h('button', {
              class: 'rail__item',
              type: 'button',
              'aria-current': () => (isRoom() && openRoom() === room.name ? 'true' : 'false'),
              onClick: () => { void selectRoom(room.name); },
            },
              h('span', { class: 'rail__name' }, room.name),
              h('span', { class: 'rail__meta' },
                h('span', { class: 'rail__kind--room' }, 'room'),
                ` · ${room.members.length} members · ${room.posts} posts`,
              ),
            ),
          )),
        ),
        h('p', { class: 'rail__empty' }, 'No rooms exist in this store.'),
      ),
    ),

    h('div', { class: 'rail__section' },
      h('h2', { class: 'rail__head' },
        h('span', null, 'direct'),
        h('span', { class: 'rail__count' }, () => String(inbox().length)),
      ),
      show(
        () => me() != null,
        () => h('ul', { class: 'rail__list' },
          h('li', null,
            h('button', {
              class: 'rail__item',
              type: 'button',
              'aria-current': () => (selected()?.kind === 'inbox' ? 'true' : 'false'),
              onClick: selectInbox,
            },
              h('span', { class: 'rail__name' }, 'inbox'),
              h('span', { class: 'rail__meta' },
                h('span', { class: 'rail__kind--dm' }, 'inbox'),
                () => {
                  // Two numbers, because they are two different things: a room
                  // post fanned out to me is not a DM, and calling both "6
                  // messages" would misreport what the store holds.
                  const all = inbox();
                  const dms = all.filter((m) => m.room == null || m.roomSeq == null).length;
                  const rooms = all.length - dms;
                  return ` · ${dms} dm · ${rooms} room`;
                },
              ),
            ),
          ),
        ),
        h('p', { class: 'rail__empty' }, 'Start with ', h('code', null, '--me NAME'), ' to read a human inbox here.'),
      ),
    ),
  );

  const header = () => h('header', { class: 'room-head' },
    h('div', { class: 'room-head__row' },
      h('h1', { class: 'room-head__title' }, h('code', null, () => title())),
      show(() => isRoom(),
        h('span', { class: 'tag tag--room' }, 'room'),
        h('span', { class: 'tag tag--dm' }, 'dm'),
      ),
    ),
    h('div', { class: 'room-head__meta' },
      show(() => isRoom() && roomMeta() != null,
        () => [
          h('span', null, `${(roomMeta()?.members ?? []).length} members`),
          h('span', null, (roomMeta()?.members ?? []).join(' · ')),
        ],
      ),
      h('span', null, () => `store ${config()?.storeBase ?? '…'}`),
      h('span', null, () => (isRoom() ? `cursor #${cursor()}` : 'not streamed')),
    ),
    h('div', { class: () => streamWords().cls },
      h('span', { class: 'ring', 'aria-hidden': 'true' }),
      h('span', { class: 'stream__label' }, () => streamWords().word),
      show(
        () => phase() === 'down',
        h('span', { class: 'stream__note' }, '· the pipe dropped; the reader keeps its own cursor'),
      ),
    ),
    h('hr', { class: 'room-head__rule' }),
  );

  const rosterPane = () => h('aside', { class: 'roster', 'aria-label': 'Participants' },
    h('h2', { class: 'rail__head' },
      h('span', null, 'participants'),
      h('span', { class: 'rail__count' }, () => String(roster().length)),
    ),
    show(
      () => roster().length > 0,
      () => h('ul', { class: 'roster__list' },
        Each(roster, (entry) => RosterItem(entry)),
      ),
      () => {
        switch (rosterState()) {
          case 'loading':
          case 'idle':
            // Not "none exist" — we have not heard back yet.
            return h('p', { class: 'rail__empty rail__empty--pending' }, 'Reading participants…');
          case 'failed':
            return h('p', { class: 'rail__empty' },
              'The participant list could not be read from this store. ',
              'That is a failure of this reader, not evidence that the store is empty.',
            );
          default:
            return h('p', { class: 'rail__empty' }, 'No participant records in this store.');
        }
      },
    ),
    h('p', { class: 'roster__note' },
      'Presence here is a ', h('strong', null, 'lease'), ', not liveness: a client writes it and it expires on read. ',
      h('code', null, 'online'), ' means a lease is live, ',
      h('code', null, 'away'), ' means the last declaration is older than its window, ',
      h('code', null, 'offline'), ' means it has lapsed far enough to stop claiming anything, and ',
      h('code', null, 'unknown'), ' means nothing was ever declared. None of them mean a person is watching.',
    ),
    h('button', { class: 'rail__item', type: 'button', onClick: refresh },
      h('span', { class: 'rail__name' }, 'refresh'),
      h('span', { class: 'rail__meta' }, 're-sample receipts and roster'),
    ),
  );

  const view = () => h('div', { class: 'app' },
    h('a', { class: 'skip', href: '#log' }, 'Skip to the log'),
    rail(),
    h('main', { class: 'main' },
      header(),
      // The list is a STABLE element. Only the keyed list inside it is reactive.
      //
      // This is load-bearing, not tidiness. Building the whole <ol> inside a
      // reactive accessor means every change to anything it reads — the phase,
      // the row array, the selection — destroys the element and rebuilds every
      // row from scratch. New nodes for old rows replay the arrival animation on
      // the entire log, which criterion 3 calls worse than no motion at all.
      // A test asserts node identity survives an append; that assertion is what
      // caught this.
      h('section', {
        class: () => (stateBlock() == null ? 'log' : 'log log--state'),
        id: 'log',
        'aria-live': 'polite',
        'aria-label': 'Message log',
      },
        // The state slot lives beside the list and is emptied, not swapped for
        // it, so the list is never unmounted by an error or an empty room.
        h('div', { class: 'log__state' }, () => stateBlock()),
        h('ol', {
          class: () => (stateBlock() == null ? 'log__list' : 'log__list log__list--hidden'),
        },
          Each(visibleRows, (row) =>
            row._kind === 'gap'
              ? Gap(row)
              : Row({
                post: row,
                me: me(),
                context: isRoom() ? 'room' : 'inbox',
                deliveries: deliveriesFor(row.id),
              }))),
      ),
    ),
    rosterPane(),
  );

  // `render` appends into the container; it does not replace its contents. The
  // pre-boot shell in index.html is a fallback for a module that never runs, so
  // it must be cleared the moment one does — otherwise every page carries a
  // "Starting the reader…" heading above a reader that already started.
  const root = document.getElementById('app');
  root.replaceChildren();
  render(view, root);
  void boot();
});
