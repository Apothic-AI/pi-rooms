/**
 * pi-rooms
 *
 * Rooms, direct messages and reply-all for pi sessions, over plain files.
 * No daemon, no server, no database: presence is a directory of pids, a
 * message is a file, and a room is an append-only line log.
 *
 * Designed for a fleet that already has an orchestrator: a leader creates a
 * room with a fixed set of agents, everyone in it can post, and the history
 * is readable by sequence number so a late joiner can catch up.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, type RoomsConfig } from "./src/config.ts";
import {
  archive,
  addRoomMember,
  appendPost,
  appendRoomEvent,
  bootId,
  claimName,
  createRoom,
  defaultName,
  deliver,
  discardQueuedRoomMessages,
  drain,
  findReceived,
  isValidName,
  isValidRoom,
  JOIN_EVENT_TEXT,
  LEAVE_EVENT_TEXT,
  listAgents,
  listRooms,
  procIdentity,
  readPosts,
  readRegistration,
  receiptDirFor,
  consolidateReceipts,
  readRoom,
  readRoster,
  register,
  removeRoomMember,
  resolveBase,
  resolvePaths,
  roomSeq,
  sanitize,
  slugify,
  unregister,
  uniqueMembers,
  type Delivery,
  type Paths,
  type Registration,
  type Room,
} from "./src/store.ts";
import { claimPin, listPins, pinPath, readPinFile, resolvePin, writePinFile } from "./src/pins.ts";

interface SessionState {
  name: string;
  /** False until explicit join when autoJoin is disabled: name is only intent. */
  joined: boolean;
  paths: Paths;
  config: RoomsConfig;
  sendsUsed: number;
  watcher: fs.FSWatcher | null;
  poller: NodeJS.Timeout | null;
  /** Pending follow-up flush for a bounded batch that had a remainder. */
  continuation: NodeJS.Timeout | null;
  /** Inbox the pending continuation drains, so a takeover can cancel it. */
  continuationName: string | null;
  /** Inboxes of names this session has left, still being drained for a grace window. */
  grace: Map<string, { timer: NodeJS.Timeout; stop: NodeJS.Timeout; until: number }>;
  draining: boolean;
  /** Pin key the current name came from, when it came from a pin. */
  pinKey: string | null;
  /** Last applied request; losing a competing holder is not a rename request. */
  intent: string | null;
  /** Targets already reported absent; reset when a send observes a live holder. */
  absentNotices: Set<string>;
  /** Attributes captured once, from the environment of this process. */
  paneId: string | undefined;
  tabId: string | undefined;
  workspaceId: string | undefined;
  sessionId: string | undefined;
}

function text(body: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: body }], details };
}

function fail(body: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: body }], details, isError: true };
}

function nowIso(): string {
  return new Date().toISOString();
}

function shortTime(iso: string): string {
  return iso.slice(11, 16);
}

/** Milliseconds between a queue stamp and now, or null when it cannot be read. */
function ageOf(iso: string | undefined): number | null {
  if (iso == null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Date.now() - then);
}

/** Coarse, human-readable age: "6h 12m". Used in stale prefixes. */
function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Delay before continuing a bounded flush, so a burst does not wait for the poller. */
const CONTINUATION_MS = 250;

/**
 * How long a renamed lane keeps draining the inbox it left behind.
 *
 * A rename is not an identity change: peers that have not noticed it yet keep
 * addressing the old name, and `deliver()` queues for any valid name whether or
 * not a session holds it. Without this window those messages land in an inbox no
 * watcher points at and are never delivered or receipted. Bounded, so a name that
 * is genuinely retired does not stay half-alive forever.
 */
const RENAME_GRACE_MS = 120_000;
const RENAME_GRACE_INTERVAL_MS = 1_000;

/** Normalise the `to` parameter, which accepts one name or a list. */
function toList(value: string | string[]): string[] {
  return uniqueMembers(Array.isArray(value) ? value : [value]);
}

export default function (pi: ExtensionAPI): void {
  let session: SessionState | null = null;

  /**
   * Resolve this session's name.
   *
   * Runs on every tool call rather than once at session start, which is what
   * lets an operator pin a name for a lane that is already running: the next
   * call picks the pin up. An explicit `PI_ROOMS_NAME` short-circuits the pin
   * file entirely, so a pin can never override it.
   */
  function refreshName(active: SessionState, cwd: string): void {
    const explicit = (process.env.PI_ROOMS_NAME ?? process.env.PI_AGENT_NAME ?? "").trim();
    if (explicit.length > 0) {
      const slug = slugify(explicit);
      if (isValidName(slug)) {
        applyIntent(active, `env:${slug}`, slug, cwd);
        active.pinKey = null;
        return;
      }
    }
    const resolved = resolvePin(active.paths, {
      sessionId: active.sessionId,
      paneId: active.paneId,
      cwd,
      pid: process.pid,
    });
    if (resolved != null && resolved.name.length > 0) {
      applyIntent(active, `pin:${resolved.key}:${resolved.name}`, resolved.name, cwd);
      active.pinKey = resolved.key;
      if (active.joined && active.name === resolved.name) {
        claimPin(active.paths, { sessionId: active.sessionId, paneId: active.paneId, cwd, pid: process.pid });
      }
    } else if (!active.joined) {
      // Deferred names are requests, not entitlements. Rejection/removal of a
      // previously eligible pin must discard it before any claim or delivery.
      applyIntent(active, `derived:${cwd}`, defaultName(cwd), cwd);
      active.pinKey = null;
    }
  }

  function applyIntent(active: SessionState, intent: string, desired: string, cwd: string): void {
    if (!active.joined) {
      active.name = desired;
      active.intent = intent;
      return;
    }
    if (active.intent === intent) return;
    const name = claimName(active.paths, desired, process.pid, cwd);
    if (name !== active.name) {
      releaseClaimedName(active);
      active.name = name;
      putRegistration(active, cwd);
    }
    active.intent = intent;
  }

  /** Drop the previous name's registration so a rename leaves no ghost behind. */
  function releaseClaimedName(active: SessionState): void {
    if (active.joined) unregister(active.paths, active.name, process.pid);
  }

  function ensure(ctx: ExtensionContext): SessionState {
    if (session != null) {
      const previous = session.name;
      refreshName(session, ctx.cwd);
      // A pin can rename a running lane on its next tool call; the watcher has to
      // follow it or the lane goes deaf to its own inbox.
      if (session.joined && session.name !== previous) rebindWatcher(session, ctx, previous);
      return session;
    }
    const paths = resolvePaths(resolveBase());
    const config = loadConfig(paths);
    const desired = defaultName(ctx.cwd);
    const name = config.autoJoin ? claimName(paths, desired, process.pid, ctx.cwd) : desired;
    session = {
      name,
      joined: config.autoJoin,
      paths,
      config,
      sendsUsed: 0,
      watcher: null,
      poller: null,
      continuation: null,
      continuationName: null,
      grace: new Map(),
      draining: false,
      pinKey: null,
      intent: null,
      absentNotices: new Set(),
      paneId: nonEmpty(process.env.HERDR_PANE_ID),
      tabId: nonEmpty(process.env.HERDR_TAB_ID),
      workspaceId: nonEmpty(process.env.HERDR_WORKSPACE_ID),
      sessionId: nonEmpty(ctx.sessionManager?.getSessionId()) ?? nonEmpty(process.env.PI_SESSION_ID),
    };
    refreshName(session, ctx.cwd);
    return session;
  }

  function pinFileFor(paths: Paths): string {
    return pinPath(paths);
  }

  /**
   * Accept a bare session id, or an explicit `session:`/`pane:`/`cwd:` key.
   *
   * The bare form is treated as a session id because that is the key the docs
   * prefer: it survives pane churn, and a caller who types just an id most
   * likely means the stable thing rather than the recyclable one.
   */
  function normaliseKey(active: SessionState, raw: string): string {
    const key = raw.trim();
    if (key.startsWith("session:") || key.startsWith("pane:") || key.startsWith("cwd:")) return key;
    if (key === "this" || key === "me") {
      if (active.sessionId != null) return `session:${active.sessionId}`;
      if (active.paneId != null) return `pane:${active.paneId}`;
    }
    return `session:${key}`;
  }

  function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  function join(ctx: ExtensionContext): SessionState {
    // ensure resolves current inputs while still unjoined, including fallback
    // when a cached pin is no longer eligible. Only then take the locked claim.
    const active = ensure(ctx);
    const firstJoin = !active.joined;
    if (firstJoin) {
      active.name = claimName(active.paths, active.name, process.pid, ctx.cwd);
      active.joined = true;
      refreshName(active, ctx.cwd);
    }
    putRegistration(active, ctx.cwd);
    if (firstJoin) {
      startWatcher(ctx);
      flush(ctx);
    }
    return active;
  }

  function putRegistration(active: SessionState, cwd: string): void {
    const entry: Registration = {
      name: active.name,
      pid: process.pid,
      cwd,
      bootId: bootId() ?? undefined,
      procId: procIdentity(process.pid) ?? undefined,
      paneId: active.paneId,
      tabId: active.tabId,
      workspaceId: active.workspaceId,
      sessionId: active.sessionId,
      model: process.env.PI_MODEL,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    const existing = listAgents(active.paths).find((a) => a.name === active.name);
    register(active.paths, { ...entry, startedAt: existing?.startedAt ?? entry.startedAt });
  }

  /**
   * Spend one unit of the outbound budget.
   *
   * Unbounded by default: when no cap is configured this always allows the
   * send. When `maxSendsPerSession` is set, the cap is enforced here, on the
   * only path that can send anything, so the limiter cannot be routed around.
   */
  function spendBudget(active: SessionState): string | null {
    const cap = active.config.maxSendsPerSession;
    if (cap == null) {
      active.sendsUsed += 1;
      return null;
    }
    if (active.sendsUsed >= cap) {
      return (
        `Send budget reached (${active.sendsUsed}/${cap} this session). ` +
        `Raise maxSendsPerSession in the pi-rooms config if this is deliberate.`
      );
    }
    active.sendsUsed += 1;
    return null;
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /** A sender-side observation, not a delivery acknowledgement or queue policy. */
  function queueMessage(active: SessionState, message: Delivery): { written: string[]; notice: string } {
    const written = deliver(active.paths, message);
    const live = new Set(listAgents(active.paths).map((agent) => agent.name));
    for (const name of live) active.absentNotices.delete(name);
    const absent = written.filter((name) => !live.has(name) && !active.absentNotices.has(name));
    for (const name of absent) active.absentNotices.add(name);
    return {
      written,
      notice: absent.length === 0 ? "" : `\nNo live holder observed for ${absent.join(", ")}. Queue preserved without expiry; this is not a delivery acknowledgement.`,
    };
  }

  function render(message: Delivery, staleAfterMs = Number.POSITIVE_INFINITY): string {
    const header =
      message.room != null
        ? `[room ${message.room}${message.roomSeq != null ? ` #${message.roomSeq}` : ""}] ${message.from}`
        : `[dm] ${message.from}`;
    const hints = [
      `id ${message.id.slice(0, 8)}`,
      message.room != null
        ? `read: rooms_read({room:"${message.room}", since:${message.roomSeq ?? 0}})`
        : `reply: rooms_dm({to:"${message.from}"}) · reply to all: rooms_reply_all({messageId:"${message.id}"})`,
    ];
    // A message that waited a long time must never arrive looking like fresh
    // conversation: the age is part of the message, not a detail the model has to
    // infer from a stamp it cannot see.
    const age = ageOf(message.queuedAt ?? message.sentAt);
    const stale = age != null && age >= staleAfterMs ? `[stale · queued ${formatAge(age)} ago]\n` : "";
    return `${stale}${header} · ${hints.join(" · ")}\n\n${message.text}`;
  }


  /**
   * Whether this name's inbox may be drained right now.
   *
   * The session's own inbox always may. An inbox it has left — a rename — may only
   * be drained while that grace window is open *and* no other live agent holds the
   * name: from the moment another process answers to it, the inbox is theirs, and
   * delivering (and archiving) from it would steal their mail.
   *
   * Every old-inbox drain goes through this, immediately before it runs. Checking
   * once when the window opens is not enough: a bounded batch leaves a continuation
   * queued behind it, and a takeover can happen in that gap.
   */
  function canDrain(active: SessionState, name: string): boolean {
    if (!active.joined) return false;
    if (name === active.name) return readRegistration(active.paths, name)?.pid === process.pid;
    const grace = active.grace.get(name);
    if (grace == null || Date.now() >= grace.until) return false;
    return !listAgents(active.paths).some((agent) => agent.name === name && agent.pid !== process.pid);
  }

  /**
   * Hand the queued messages to this session.
   *
   * Two rules keep a catch-up from derailing the turn it lands in:
   *
   * 1. bounded — at most `maxDeliverPerFlush` transcripts per tick, the rest stay
   *    queued for the next one, in arrival order, and a short continuation picks
   *    them up rather than waiting for the poll interval;
   * 2. one wake — only the first handoff of a flush asks for a turn, so an idle
   *    lane is woken once per batch instead of once per message.
   *
   * There is deliberately no "digest" that summarises a backlog into one line.
   * A digest cannot be lossless: a direct message has no read tool (`rooms_read`
   * is rooms-only, `rooms_dm` only sends), so summarising a DM would archive it as
   * delivered while its body became unreachable. Every message here is therefore
   * handed over in full, marked with its age when it is old.
   *
   * `nameOverride` drains another inbox once, which is what a rename needs: the
   * inbox the session is leaving behind must not keep a queue nobody will read.
   * That drain, and any continuation behind it, is refused the moment another live
   * agent holds the name — see {@link canDrain}.
   */
  /**
   * Give up on an inbox this session has left.
   *
   * Called the moment any old-inbox path observes that the name is no longer ours —
   * a live holder, or a closed window. Closing the window here, rather than waiting
   * for the next interval tick to notice independently, is what stops a holder who
   * appears and disappears inside one tick from re-opening delivery: the interval
   * and the continuation both go with the window.
   */
  function abandonOldDrain(active: SessionState, name: string): void {
    if (name === active.name) return;
    stopGraceDrain(active, name);
  }

  function flush(context: ExtensionContext, nameOverride?: string): void {
    const active = session;
    if (active == null || active.draining) return;
    const name = nameOverride ?? active.name;
    if (!canDrain(active, name)) {
      abandonOldDrain(active, name);
      return;
    }
    active.draining = true;
    let more = false;
    let lostName = false;
    try {
      const pending = drain(active.paths, name);
      if (pending.length === 0) return;
      const injectedAt = nowIso();
      const batch = pending.slice(0, active.config.maxDeliverPerFlush);
      more = pending.length > batch.length;
      for (const [index, entry] of batch.entries()) {
        // Re-checked before *every* handoff, not once per batch: a claim can land
        // while this batch is running, and the rest of the batch is that holder's
        // mail from that moment on. What was already handed over keeps its receipt
        // and archive; the untouched remainder is left in the inbox.
        if (!canDrain(active, name)) {
          abandonOldDrain(active, name);
          lostName = true;
          break;
        }
        const isRoom = entry.message.room != null;
        pi.sendMessage(
          {
            customType: "pi_rooms_message",
            content: render(entry.message, active.config.staleAfterMs),
            display: true,
            details: entry.message,
          },
          {
            triggerTurn: index === 0,
            deliverAs: isRoom ? active.config.roomDelivery : active.config.dmDelivery,
          },
        );
        // archive stamps deliveredAt and writes the receipt; it runs after the
        // handoff so a crash between the two reports "queued" rather than a
        // delivery that never happened. injectedAt records that this flush is the
        // one that handed it over.
        archive(active.paths, name, entry.file, entry.message, { injectedAt });
      }
    } catch {
      /* a failed flush must not break the session; the next tick retries */
    } finally {
      active.draining = false;
    }
    // A lost name is not a remainder: nothing may be scheduled to drain it again.
    if (more && !lostName) scheduleNextFlush(context, name);
  }

  /**
   * Continue a bounded flush shortly after it stopped, rather than waiting for the
   * poller: a burst of 20 messages should not take 8 poll intervals to arrive.
   *
   * The eligibility check is repeated here and again inside the timer, because a
   * takeover can land between scheduling and firing.
   */
  function scheduleNextFlush(context: ExtensionContext, name: string): void {
    const active = session;
    if (active == null || active.continuation != null) return;
    if (!canDrain(active, name)) {
      abandonOldDrain(active, name);
      return;
    }
    const timer = setTimeout(() => {
      if (active.continuation === timer) {
        active.continuation = null;
        active.continuationName = null;
      }
      if (session !== active) return;
      if (!canDrain(active, name)) {
        abandonOldDrain(active, name);
        return;
      }
      flush(context, name === active.name ? undefined : name);
    }, CONTINUATION_MS);
    timer.unref();
    active.continuation = timer;
    active.continuationName = name;
  }

  /** Drop a queued continuation, for one name when given, or for any. */
  function cancelContinuation(active: SessionState, name?: string): void {
    if (active.continuation == null) return;
    if (name != null && active.continuationName !== name) return;
    clearTimeout(active.continuation);
    active.continuation = null;
    active.continuationName = null;
  }

  function watchDirFor(active: SessionState): string {
    return path.join(active.paths.inbox, active.name);
  }

  /** Bind the watcher and poller to the current name's inbox. */
  function openWatcher(active: SessionState, context: ExtensionContext): void {
    const dir = watchDirFor(active);
    try {
      fs.mkdirSync(dir, { recursive: true });
      let timer: NodeJS.Timeout | null = null;
      const watcher = fs.watch(dir, () => {
        if (timer != null) return;
        timer = setTimeout(() => {
          timer = null;
          flush(context);
        }, 50);
      });
      // A plugin must never be the reason pi cannot exit; the poller below is
      // unref'd for the same reason.
      watcher.unref();
      active.watcher = watcher;
    } catch {
      /* fall through to polling only */
    }
    active.poller = setInterval(() => flush(context), active.config.pollMs);
    active.poller.unref();
  }

  function startWatcher(context: ExtensionContext): void {
    const active = session;
    if (active == null || !active.joined || active.watcher != null) return;
    openWatcher(active, context);
  }

  function closeWatcher(active: SessionState): void {
    active.watcher?.close();
    active.watcher = null;
    if (active.poller != null) clearInterval(active.poller);
    active.poller = null;
    cancelContinuation(active);
    for (const { timer, stop } of active.grace.values()) {
      clearInterval(timer);
      clearTimeout(stop);
    }
    active.grace.clear();
  }

  /**
   * Keep draining an inbox this session has left, for a bounded window.
   *
   * Only messages that arrive *after* the rebind need this: the one-off drain in
   * {@link rebindWatcher} covers the backlog. The window closes on time, when the
   * session ends, or when another live agent takes the name — and closing it also
   * drops any continuation still queued behind a batch.
   */
  function startGraceDrain(active: SessionState, context: ExtensionContext, name: string): void {
    const existing = active.grace.get(name);
    if (existing != null) {
      clearInterval(existing.timer);
      clearTimeout(existing.stop);
    }
    const timer = setInterval(() => {
      if (session !== active || !canDrain(active, name)) {
        abandonOldDrain(active, name);
        return;
      }
      flush(context, name);
    }, RENAME_GRACE_INTERVAL_MS);
    timer.unref();
    const stop = setTimeout(() => stopGraceDrain(active, name), RENAME_GRACE_MS);
    stop.unref();
    active.grace.set(name, { timer, stop, until: Date.now() + RENAME_GRACE_MS });
  }

  function stopGraceDrain(active: SessionState, name: string): void {
    const entry = active.grace.get(name);
    if (entry == null) return;
    clearInterval(entry.timer);
    clearTimeout(entry.stop);
    active.grace.delete(name);
    // A stopped window must not be finished off by a continuation queued while it
    // was still open.
    cancelContinuation(active, name);
  }

  function stopWatcher(): void {
    const active = session;
    if (active == null) return;
    closeWatcher(active);
  }

  /**
   * Follow a name change.
   *
   * The watcher is bound to one directory, so a rename that only updated the name
   * would leave this lane watching an inbox nobody writes to — served by the 2s
   * poller at best — while the old inbox kept collecting messages this session no
   * longer answers to. Rebinding drains the inbox being left behind once, and a
   * bounded grace drain keeps taking mail that is still addressed to the old name.
   */
  function rebindWatcher(active: SessionState, context: ExtensionContext, previousName: string): void {
    closeWatcher(active);
    openWatcher(active, context);
    if (previousName === active.name) return;
    // Open the window first, so the one-off backlog drain below already has one to
    // be judged against by canDrain().
    startGraceDrain(active, context, previousName);
    flush(context, previousName);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const active = ensure(ctx);
    if (active.config.autoJoin) join(ctx);
    startWatcher(ctx);
    flush(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-rooms", `rooms: ${active.name}`);
    }
  });

  pi.on("session_shutdown", async () => {
    const active = session;
    if (active == null) return;
    stopWatcher();
    releaseClaimedName(active);
    session = null;
  });

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "rooms_who",
    label: "Rooms: who is here",
    description:
      "List the pi agents currently live on this machine, with the directory and model each one runs in. " +
      "Use it before messaging anyone, or to check whether a peer is still running.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = ensure(ctx);
      const agents = listAgents(active.paths);
      const width = Math.min(28, Math.max(12, ...agents.map((a) => a.name.length + 2)));
      const lines = agents.map((a) => {
        const pane = a.paneId != null ? a.paneId.padEnd(9) : "-".padEnd(9);
        const tab = a.tabId != null ? `  ${a.tabId}` : "";
        return (
          `${a.name === active.name ? "*" : " "} ${a.name.padEnd(width)} ${pane} ${a.cwd}${tab}` +
          `${a.model != null ? `  (${a.model})` : ""}`
        );
      });
      const body =
        agents.length === 0
          ? "No agents registered."
          : `${agents.length} agent(s) · you are ${active.name}` +
            `${active.paneId != null ? ` at ${active.paneId}` : ""}\n` +
            `${lines.join("\n")}`;
      return text(body, { self: active.name, pane: active.paneId, agents });
    },
  });

  pi.registerTool({
    name: "rooms_pins",
    label: "Rooms: name pins",
    description:
      "Inspect and edit name pins in names.json. `list` shows every pin and whether it is claimed, so you " +
      "can tell an ignored pin from an absent one. `set` pins a name, keyed by session id (preferred: it " +
      "survives pane churn), herdr pane id, or cwd. `remove` deletes a pin.\n\n" +
      "Renaming a lane is leave-and-join, not an alias: it drops the lane out of every room keyed on its old " +
      "name. `set` refuses to rename a lane that is a member of a room unless force is true.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("list"), Type.Literal("set"), Type.Literal("remove")], {
          description: "Defaults to list",
        }),
      ),
      key: Type.Optional(
        Type.String({
          description:
            "Pin key: `session:<PI_SESSION_ID>`, `pane:<HERDR_PANE_ID>`, or `cwd:<absolute path>`. " +
            "A bare value with no prefix is treated as a session id.",
        }),
      ),
      name: Type.Optional(Type.String({ description: "Name to pin (set only)" })),
      force: Type.Optional(Type.Boolean({ description: "Proceed despite a room membership or foreign claim" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = ensure(ctx);
      const action = params.action ?? "list";

      if (action === "list") {
        const pins = listPins(active.paths);
        const rejected = resolvePin(active.paths, {
          sessionId: active.sessionId,
          paneId: active.paneId,
          cwd: ctx.cwd,
          pid: process.pid,
        })?.rejected;
        const header = `you are ${active.name}${active.paneId != null ? ` at ${active.paneId}` : ""}\n`;
        if (pins.length === 0) {
          return text(
            `${header}No pins in ${pinFileFor(active.paths)}.\n` +
              `Pin with rooms_pins({action:"set", key:"session:${active.sessionId ?? "<session-id>"}", name:"my-lane"}).`,
            { pins: [] },
          );
        }
        const lines = pins.map((p) => {
          const state = !p.valid ? "invalid name" : p.claimed ? "claimed" : "unclaimed";
          const preferred = p.key.startsWith("session:") ? "*" : " ";
          return `${preferred}${p.key.padEnd(38)} ${p.name.padEnd(20)} ${state}`;
        });
        return text(
          `${header}${pins.length} pin(s) · * = preferred key\n${lines.join("\n")}` +
            (rejected != null ? `\nA pin is being ignored: ${rejected.key} — ${rejected.reason}` : "") +
            `\nAn explicit PI_ROOMS_NAME beats every pin.`,
          { pins, rejected },
        );
      }

      if (params.key == null) return fail(`${action} needs a key.`);
      const key = normaliseKey(active, params.key);

      if (action === "remove") {
        const file = readPinFile(active.paths);
        if (file.pins[key] == null) return fail(`No pin for ${key}.`);
        delete file.pins[key];
        writePinFile(active.paths, file);
        return text(`Removed pin ${key}.`, { key });
      }

      if (params.name == null) return fail("set needs a name.");
      const wanted = slugify(params.name);
      if (!isValidName(wanted)) {
        return fail(`"${params.name}" is not a valid name: lowercase letters, digits, dash, underscore.`);
      }

      // Renaming is leave-and-join, so it is refused when it would silently eject
      // a lane from a room. This is the loud part: the failure mode is that the
      // lane simply stops being a member and nothing else complains.
      const rooms = listRooms(active.paths).filter((r) => r.members.includes(active.name));
      if (wanted !== active.name && rooms.length > 0 && params.force !== true) {
        return fail(
          `Refusing to rename ${active.name} -> ${wanted}: it is a member of ${rooms
            .map((r) => r.name)
            .join(", ")}. Rooms store members by name and there is no rename alias, so renaming leaves ` +
            `those rooms. Pin the lane before creating rooms over it, or pass force:true to proceed.`,
        );
      }

      const file = readPinFile(active.paths);
      const existing = file.pins[key];
      const current = procIdentity(process.pid);
      if (
        existing != null &&
        existing.procId != null &&
        current != null &&
        existing.procId !== current &&
        params.force !== true
      ) {
        return fail(
          `${key} is already claimed by a different process. Overwriting it would let this lane take that ` +
            `identity. Use action:"remove" to free it deliberately, or force:true.`,
        );
      }
      file.pins[key] = { name: wanted, note: existing?.note };
      writePinFile(active.paths, file);

      const appliesHere =
        (active.sessionId != null && key === `session:${active.sessionId}`) ||
        (active.paneId != null && key === `pane:${active.paneId}`);
      if (appliesHere) {
        const previous = active.name;
        refreshName(active, ctx.cwd);
        if (active.joined && active.name !== previous) rebindWatcher(active, ctx, previous);
        join(ctx);
      }

      return text(
        `Pinned ${key} -> ${wanted}.` +
          (appliesHere
            ? ` This session is now ${active.name}.`
            : ` It applies on that lane's next tool call.`) +
          (rooms.length > 0 && wanted !== active.name ? ` Left rooms: ${rooms.map((r) => r.name).join(", ")}.` : ""),
        { key, name: wanted, appliedHere: appliesHere, leftRooms: rooms.map((r) => r.name) },
      );
    },
  });

  pi.registerTool({
    name: "rooms_receipts",
    label: "Rooms: receipts",
    description:
      "Receipt maintenance. `consolidate` folds the per-recipient receipt files back into the legacy " +
      "single-file layout (`<base>/receipts/<id>.json`), which is the rollback step for a build that only " +
      "understands that layout — without it, every message it delivered reads as still queued. It merges " +
      "into the existing record instead of replacing it, and running it twice changes nothing. " +
      "Delivery is unaffected: it only writes receipts.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("consolidate")], {
          description: "Defaults to consolidate; the only action today",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = ensure(ctx);
      void params;
      const result = consolidateReceipts(active.paths);
      return text(
        `Consolidated ${result.messages} message(s), ${result.recipients} new recipient receipt(s) ` +
          `into ${active.paths.receipts}/<id>.json.\n` +
          `Safe to repeat; a build that only reads the legacy layout now sees these receipts.`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "rooms_dm",
    label: "Rooms: direct message",
    description:
      "Send a direct message to one agent, or to several by passing an array. " +
      "The recipient list is recorded on the message, so any recipient can answer everyone with rooms_reply_all.",
    parameters: Type.Object({
      to: Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "Agent name, or an array of names",
      }),
      message: Type.String({ description: "Message body" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const recipients = toList(params.to);
      if (recipients.length === 0) return fail("No valid recipient names given.");
      const over = spendBudget(active);
      if (over != null) return fail(over);
      const body = sanitize(params.message);
      const message: Delivery = {
        id: randomUUID(),
        from: active.name,
        to: recipients,
        text: body,
        sentAt: nowIso(),
      };
      const { written, notice } = queueMessage(active, message);
      const missing = recipients.filter((r) => !written.includes(r));
      return text(
        `Queued to ${written.length} agent(s)${missing.length > 0 ? `; skipped ${missing.join(", ")}` : ""}. id ${message.id}\n` +
          `Queued is not delivered: each recipient's session records a deliveredAt when it is handed the message. ` +
          `The receipts are per recipient under ${receiptDirFor(active.paths, message.id)}/.` + notice,
        { id: message.id, delivered: written, skipped: missing },
      );
    },
  });

  pi.registerTool({
    name: "rooms_reply_all",
    label: "Rooms: reply to all",
    description:
      "Answer every recipient of a message you received, using the recipient list recorded when it was sent. " +
      "For a room message it posts into the room instead. Use the 8-character id shown in the delivered message.",
    parameters: Type.Object({
      messageId: Type.String({ description: "The message id shown in the delivered message" }),
      message: Type.String({ description: "Your reply" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const original = findReceived(active.paths, active.name, params.messageId.trim());
      if (original == null) {
        return fail(
          `No message ${params.messageId} in your inbox history. Pass the full id from the delivered message, ` +
            `or use rooms_dm with explicit recipients.`,
        );
      }
      // A room message can only be answered by a member. Leaving has to be an exit
      // from the room's speech as well as its traffic, and membership — not holding
      // an old copy of the message — is what decides that. rooms_post already
      // refuses a non-member; this is the same door.
      if (original.room != null) {
        const membership = readRoom(active.paths, original.room);
        if (membership == null) return fail(`Room ${original.room} no longer exists.`);
        if (!membership.members.includes(active.name)) {
          return fail(
            `You are not a member of ${original.room}, so it does not accept this reply. Re-enter with ` +
              `rooms_join({room:"${original.room}"}), or answer ${original.from} directly with rooms_dm.`,
          );
        }
      }
      const over = spendBudget(active);
      if (over != null) return fail(over);
      const body = sanitize(params.message);
      // The sender is not in `to`, so a reply-all that used `to` alone would silently
      // leave out the one agent who asked. Both sets minus yourself is the answer set.
      const recipients = uniqueMembers([original.from, ...original.to]).filter(
        (name) => name !== active.name,
      );
      if (original.room != null) {
        const room = readRoom(active.paths, original.room);
        if (room == null) return fail(`Room ${original.room} no longer exists.`);
        const seq = appendPost(active.paths, room.name, {
          from: active.name,
          text: body,
          sentAt: nowIso(),
          recipients: room.members.filter((m) => m !== active.name),
        });
        const { notice } = queueMessage(active, {
          id: randomUUID(),
          from: active.name,
          to: room.members.filter((m) => m !== active.name),
          text: body,
          sentAt: nowIso(),
          room: room.name,
          roomSeq: seq,
          replyTo: original.id,
        });
        return text(`Replied in room ${room.name} at #${seq}.` + notice, { room: room.name, seq });
      }
      if (recipients.length === 0) return fail("That message had no other recipients to reply to.");
      const message: Delivery = {
        id: randomUUID(),
        from: active.name,
        to: recipients,
        text: body,
        sentAt: nowIso(),
        replyTo: original.id,
      };
      const { written, notice } = queueMessage(active, message);
      return text(`Replied to ${written.length} recipient(s): ${written.join(", ")}.` + notice, {
        id: message.id,
        delivered: written,
      });
    },
  });

  pi.registerTool({
    name: "rooms_create",
    label: "Rooms: create",
    description:
      "Create a room with a fixed set of agents. The creator is a member. " +
      "Anyone in the room can post to it, and its history is readable with rooms_read.",
    parameters: Type.Object({
      room: Type.String({ description: "Room name: lowercase letters, digits, dash, underscore" }),
      members: Type.Optional(
        Type.Array(Type.String(), { description: "Agent names to include besides yourself" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const name = slugify(params.room);
      if (!isValidRoom(name)) return fail("Room names are up to 32 lowercase letters, digits, dash or underscore.");
      const existing = readRoom(active.paths, name);
      if (existing != null) {
        return fail(
          `Room ${name} already exists with members: ${existing.members.join(", ")}. ` +
            `Post to it, or join it with rooms_join.`,
        );
      }
      const members = uniqueMembers([active.name, ...(params.members ?? [])]);
      const room: Room = {
        name,
        members,
        createdBy: active.name,
        createdAt: nowIso(),
      };
      createRoom(active.paths, room);
      const live = new Set(listAgents(active.paths).map((a) => a.name));
      const offline = members.filter((m) => !live.has(m));
      return text(
        `Room ${name} created with ${members.length} member(s): ${members.join(", ")}.` +
          (offline.length > 0 ? `\nNot currently live (they will not receive posts until they start): ${offline.join(", ")}` : ""),
        { room, offline },
      );
    },
  });

  pi.registerTool({
    name: "rooms_join",
    label: "Rooms: join",
    description:
      "Join an existing room so you receive its posts. Joining is also how you re-enter a room you left: " +
      "you are re-admitted, but posts made while you were out are not replayed — read them with rooms_read.",
    parameters: Type.Object({
      room: Type.String({ description: "Room name" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const name = slugify(params.room);
      const room = readRoom(active.paths, name);
      if (room == null) return fail(`Room ${name} does not exist.`);
      // Only a real membership change is history: a repeated join is a no-op and
      // must not fill the log with duplicate events.
      const joined = addRoomMember(active.paths, room, active.name);
      const seq = joined ? appendRoomEvent(active.paths, name, active.name, JOIN_EVENT_TEXT) : null;
      return text(
        `Joined room ${name} (${room.members.length} members): ${room.members.join(", ")}.` +
          (seq != null
            ? `\nRecorded at #${seq}. Posts made before you joined are in the history, not in your inbox.`
            : `\nYou were already a member; nothing changed.`),
        { room, joined, seq },
      );
    },
  });

  pi.registerTool({
    name: "rooms_leave",
    label: "Rooms: leave",
    description:
      "Leave a room: you stop receiving its posts, and they stop being queued for you. " +
      "The parting is appended to the room history as an event (nobody is notified), and by default your " +
      "own queued-but-undelivered messages for that room are discarded so no backlog survives the part. " +
      "Discarding leaves message receipts alone, so a discarded message honestly stays `queued`. " +
      "Re-enter with rooms_join; posts made while you were out are not replayed. Direct messages are " +
      "unaffected, and leaving the last member leaves the room in place, empty and joinable.",
    parameters: Type.Object({
      room: Type.String({ description: "Room name" }),
      discardQueued: Type.Optional(
        Type.Boolean({
          description:
            "Delete your queued, undelivered messages for this room (default true). false keeps them, so " +
            "they will still be delivered after you have left.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const name = slugify(params.room);
      const room = readRoom(active.paths, name);
      if (room == null) return fail(`Room ${name} does not exist.`);
      if (!room.members.includes(active.name)) {
        // Idempotent: being out already is the state the caller asked for.
        return text(`You are not a member of ${name}: nothing to leave.`, {
          room: name,
          left: false,
          discarded: 0,
          members: room.members,
        });
      }
      removeRoomMember(active.paths, room, active.name);
      const seq = appendRoomEvent(active.paths, name, active.name, LEAVE_EVENT_TEXT);
      const discardQueued = params.discardQueued !== false;
      const discarded = discardQueued
        ? discardQueuedRoomMessages(active.paths, active.name, name)
        : 0;
      const remaining = room.members;
      return text(
        `Left room ${name} at #${seq}. It now has ${remaining.length} member(s)` +
          `${remaining.length > 0 ? `: ${remaining.join(", ")}` : " and stays joinable"}.` +
          (discardQueued
            ? `\nDiscarded ${discarded} queued message(s) of yours for this room.`
            : `\nKept your queued messages for this room (discardQueued:false); they will still be delivered.`) +
          `\nYou receive no further posts here. Re-enter with rooms_join({room:"${name}"}); ` +
          `posts made while you were out are not replayed.`,
        { room: name, left: true, seq, discarded, members: remaining },
      );
    },
  });

  pi.registerTool({
    name: "rooms_post",
    label: "Rooms: post",
    description:
      "Post a message into a room. It is appended to the room history and pushed to every other member.",
    parameters: Type.Object({
      room: Type.String({ description: "Room name" }),
      message: Type.String({ description: "Message body" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const name = slugify(params.room);
      const room = readRoom(active.paths, name);
      if (room == null) return fail(`Room ${name} does not exist. Create it with rooms_create.`);
      if (!room.members.includes(active.name)) {
        return fail(`You are not a member of ${name}. Join it with rooms_join first.`);
      }
      const over = spendBudget(active);
      if (over != null) return fail(over);
      const body = sanitize(params.message);
      const recipients = room.members.filter((m) => m !== active.name);
      const seq = appendPost(active.paths, name, {
        from: active.name,
        text: body,
        sentAt: nowIso(),
        recipients,
      });
      const { notice } = queueMessage(active, {
        id: randomUUID(),
        from: active.name,
        to: recipients,
        text: body,
        sentAt: nowIso(),
        room: name,
        roomSeq: seq,
      });
      return text(`Posted to ${name} as #${seq}, pushed to ${recipients.length} member(s).` + notice, {
        room: name,
        seq,
        recipients,
      });
    },
  });

  pi.registerTool({
    name: "rooms_read",
    label: "Rooms: read history",
    description:
      "Read a room's history, oldest first, numbered by position. Pass `since` with the last number you saw to " +
      "fetch only what is new. This is how a late joiner catches up on a room. Membership events (joining and " +
      "leaving) appear in the same numbering, marked `· name joined the room`.",
    parameters: Type.Object({
      room: Type.String({ description: "Room name" }),
      since: Type.Optional(Type.Number({ description: "Return posts after this number (default: from the start)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum posts to return (default 50, newest kept)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const name = slugify(params.room);
      const room = readRoom(active.paths, name);
      if (room == null) return fail(`Room ${name} does not exist.`);
      const since = typeof params.since === "number" && params.since > 0 ? Math.floor(params.since) : 0;
      const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 50;
      const posts = readPosts(active.paths, name, since, limit);
      if (posts.length === 0) {
        const total = roomSeq(active.paths, name);
        return text(
          since >= total ? `No new posts in ${name} (last #${total}).` : `Room ${name} has no posts.`,
          { room: name, posts: [], total },
        );
      }
      const lines = posts.map((p) =>
        p.kind === "event"
          ? `#${p.seq} ${shortTime(p.sentAt)} · ${p.from} ${p.text}`
          : `#${p.seq} ${shortTime(p.sentAt)} ${p.from}: ${p.text}`,
      );
      return text(
        `Room ${name} · ${room.members.length} members · showing #${posts[0].seq}-#${posts[posts.length - 1].seq}\n` +
          lines.join("\n"),
        { room: name, posts, from: posts[0].seq, to: posts[posts.length - 1].seq },
      );
    },
  });

  pi.registerTool({
    name: "rooms_list",
    label: "Rooms: list",
    description: "List every room with its members and post count.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const active = ensure(ctx);
      const rooms = listRooms(active.paths);
      if (rooms.length === 0) return text("No rooms exist yet.");
      const lines = rooms.map((room) => {
        const total = roomSeq(active.paths, room.name);
        const mine = room.members.includes(active.name) ? "*" : " ";
        return `${mine} ${room.name.padEnd(20)} ${String(total).padStart(4)} post(s)  ${room.members.join(", ")}`;
      });
      return text(`${rooms.length} room(s) · you are ${active.name}\n${lines.join("\n")}`, { rooms });
    },
  });
}
