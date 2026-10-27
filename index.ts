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
  appendPost,
  bootId,
  claimName,
  createRoom,
  defaultName,
  deliver,
  drain,
  findReceived,
  isValidName,
  isValidRoom,
  listAgents,
  listRooms,
  procIdentity,
  readPosts,
  readRegistration,
  receiptPathFor,
  readRoom,
  readRoster,
  register,
  resolveBase,
  resolvePaths,
  roomSeq,
  sanitize,
  saveRoom,
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
  paths: Paths;
  config: RoomsConfig;
  sendsUsed: number;
  watcher: fs.FSWatcher | null;
  poller: NodeJS.Timeout | null;
  draining: boolean;
  /** Pin key the current name came from, when it came from a pin. */
  pinKey: string | null;
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
        if (active.name !== slug) {
          releaseClaimedName(active);
          active.name = slug;
          active.pinKey = null;
        }
        return;
      }
    }
    const resolved = claimPin(active.paths, {
      sessionId: active.sessionId,
      paneId: active.paneId,
      cwd,
      pid: process.pid,
    });
    if (resolved != null && resolved.name.length > 0 && resolved.name !== active.name) {
      releaseClaimedName(active);
      active.name = resolved.name;
      active.pinKey = resolved.key;
    }
  }

  /** Drop the previous name's registration so a rename leaves no ghost behind. */
  function releaseClaimedName(active: SessionState): void {
    const existing = readRegistration(active.paths, active.name);
    // Only remove it when it is ours; another process's registration of the
    // same name is not this session's to delete.
    if (existing != null && existing.pid === process.pid) unregister(active.paths, active.name);
  }

  function ensure(ctx: ExtensionContext): SessionState {
    if (session != null) {
      refreshName(session, ctx.cwd);
      return session;
    }
    const paths = resolvePaths(resolveBase());
    const config = loadConfig(paths);
    const desired = defaultName(ctx.cwd);
    const name = claimName(paths, desired, process.pid);
    session = {
      name,
      paths,
      config,
      sendsUsed: 0,
      watcher: null,
      poller: null,
      draining: false,
      pinKey: null,
      paneId: nonEmpty(process.env.HERDR_PANE_ID),
      tabId: nonEmpty(process.env.HERDR_TAB_ID),
      workspaceId: nonEmpty(process.env.HERDR_WORKSPACE_ID),
      sessionId: nonEmpty(process.env.PI_SESSION_ID),
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
    const active = ensure(ctx);
    const entry: Registration = {
      name: active.name,
      pid: process.pid,
      cwd: ctx.cwd,
      bootId: bootId() ?? undefined,
      procId: procIdentity(process.pid) ?? undefined,
      paneId: active.paneId,
      tabId: active.tabId,
      workspaceId: active.workspaceId,
      sessionId: process.env.PI_SESSION_ID,
      model: process.env.PI_MODEL,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    const existing = listAgents(active.paths).find((a) => a.name === active.name);
    register(active.paths, { ...entry, startedAt: existing?.startedAt ?? entry.startedAt });
    return active;
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

  function render(message: Delivery): string {
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
    return `${header} · ${hints.join(" · ")}\n\n${message.text}`;
  }

  function flush(context: ExtensionContext): void {
    const active = session;
    if (active == null || active.draining) return;
    active.draining = true;
    try {
      const pending = drain(active.paths, active.name);
      for (const entry of pending) {
        const isRoom = entry.message.room != null;
        pi.sendMessage(
          {
            customType: "pi_rooms_message",
            content: render(entry.message),
            display: true,
            details: entry.message,
          },
          {
            triggerTurn: true,
            deliverAs: isRoom ? active.config.roomDelivery : active.config.dmDelivery,
          },
        );
        // archive stamps deliveredAt and writes the receipt; it runs after the
        // handoff so a crash between the two reports "queued" rather than a
        // delivery that never happened.
        archive(active.paths, active.name, entry.file, entry.message);
      }
    } catch {
      /* a failed flush must not break the session; the next tick retries */
    } finally {
      active.draining = false;
    }
    void context;
  }

  function startWatcher(context: ExtensionContext): void {
    const active = session;
    if (active == null || active.watcher != null) return;
    const dir = path.join(active.paths.inbox, active.name);
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

  function stopWatcher(): void {
    const active = session;
    if (active == null) return;
    active.watcher?.close();
    active.watcher = null;
    if (active.poller != null) clearInterval(active.poller);
    active.poller = null;
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
    unregister(active.paths, active.name);
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
        refreshName(active, ctx.cwd);
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
      const written = deliver(active.paths, message);
      const missing = recipients.filter((r) => !written.includes(r));
      return text(
        `Queued to ${written.length} agent(s)${missing.length > 0 ? `; skipped ${missing.join(", ")}` : ""}. id ${message.id}\n` +
          `Queued is not delivered: each recipient's session records a deliveredAt when it is handed the message. ` +
          `The receipt file is ${receiptPathFor(active.paths, message.id)}.`,
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
        deliver(active.paths, {
          id: randomUUID(),
          from: active.name,
          to: room.members.filter((m) => m !== active.name),
          text: body,
          sentAt: nowIso(),
          room: room.name,
          roomSeq: seq,
          replyTo: original.id,
        });
        return text(`Replied in room ${room.name} at #${seq}.`, { room: room.name, seq });
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
      const written = deliver(active.paths, message);
      return text(`Replied to ${written.length} recipient(s): ${written.join(", ")}.`, {
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
    description: "Join an existing room so you receive its posts.",
    parameters: Type.Object({
      room: Type.String({ description: "Room name" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const active = join(ctx);
      const name = slugify(params.room);
      const room = readRoom(active.paths, name);
      if (room == null) return fail(`Room ${name} does not exist.`);
      if (!room.members.includes(active.name)) {
        room.members = uniqueMembers([...room.members, active.name]);
        saveRoom(active.paths, room);
      }
      return text(`Joined room ${name} (${room.members.length} members): ${room.members.join(", ")}.`, { room });
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
      deliver(active.paths, {
        id: randomUUID(),
        from: active.name,
        to: recipients,
        text: body,
        sentAt: nowIso(),
        room: name,
        roomSeq: seq,
      });
      return text(`Posted to ${name} as #${seq}, pushed to ${recipients.length} member(s).`, {
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
      "fetch only what is new. This is how a late joiner catches up on a room.",
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
      const lines = posts.map((p) => `#${p.seq} ${shortTime(p.sentAt)} ${p.from}: ${p.text}`);
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
