/**
 * The loopback reader. GET only. Binds `127.0.0.1` and nothing else.
 *
 * ## What this is, in the operator's words
 *
 * > a loopback server that spawns `bin/rooms read --follow` and relays its
 * > NDJSON to the browser over SSE; read-only BY CONSTRUCTION, binds 127.0.0.1
 * > only, and if it ever needs a write verb that is a new decision not a
 * > refactor.
 *
 * So there is no `POST` handler, no `PUT`, no `DELETE`, no request body parser,
 * and no route that maps to `post`, `dm`, `ack` or `join`. The method check is
 * the first statement in the request handler, before routing, so a future route
 * cannot be reached by a method it was not written for.
 *
 * ## Why this is still not §8's rejected bridge
 *
 * §8 rejected *"an HTTP/socket bridge into the store"* — something that owns
 * protocol, holds state, and invents an authentication problem. This server:
 *
 * - **holds no state** — every request spawns its own reader and forgets it. The
 *   stream cursor lives in the browser's URL (`?since=`), never here.
 * - **writes nothing** — see `readonly-fs.ts`, which is the module graph's only
 *   filesystem capability and is four read functions long.
 * - **owns no protocol** — room history and live posts are `bin/rooms`'s JSON,
 *   forwarded. This file does not parse a post, renumber a sequence, or decide
 *   what a gap means.
 * - **has no authentication** — it binds loopback and that is the entire
 *   boundary, exactly as same-uid file access is the entire boundary for the
 *   CLI. There is no token, no session, no account, and no `Authorization`
 *   header handling, because inventing one is the failure §8 named.
 *
 * The one thing it derives is the receipt ladder (`./receipts.ts`), because §5.3
 * requires it: a client that reads an absent `deliveredAt` as "not delivered"
 * re-sends mail that already arrived. That is a rule about how to *display*
 * stored bytes, not a protocol of its own.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidName, isValidRoom, resolveBase, resolvePaths } from "../../src/store.ts";
import { isDirectory, readDirNames, readTextFile, resolveInside } from "./readonly-fs.ts";
import type { RecipientDelivery } from "./receipts.ts";
import { receiptLadder } from "./receipts.ts";
import { RelayError, assertRoom, assertSince, followRoom, readJsonVerb } from "./relay.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(WEB_ROOT, "public");
const VENDOR_DIR = path.join(WEB_ROOT, "vendor");

/** The interface. Not a variable, not an environment read, not a flag. */
export const BIND_HOST = "127.0.0.1";

/**
 * Concurrent follow streams.
 *
 * Each is a child process, so this is a resource bound rather than a semantic
 * one. Eight is more browser tabs than the operator has, and a refusal is
 * visible (503 with a reason) instead of the machine quietly sprouting
 * processes.
 */
const MAX_FOLLOWERS = 8;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export interface ServerOptions {
  /** Display identity only. Never reaches a child's argv. See `handle`. */
  me?: string;
  /** 0 asks the OS for a free port, which is what the tests use. */
  port?: number;
  /** Injected so a test can point the readers at a fixture without a real store. */
  env?: NodeJS.ProcessEnv;
  /** Quiet mode for tests. */
  silent?: boolean;
}

export interface WebServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    // This is a loopback reader with no third-party content. Nothing needs to be
    // permitted, so nothing is.
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function sendError(res: ServerResponse, status: number, kind: string, message: string) {
  sendJson(res, status, { ok: false, error: { kind, message } });
}

/** Serve one file out of `root`, refusing anything that resolves outside it. */
function serveStatic(res: ServerResponse, root: string, relPath: string): boolean {
  const file = resolveInside(root, relPath);
  if (file == null || !isDirectory(root)) {
    sendError(res, 404, "not-found", `no such file: ${relPath}`);
    return false;
  }
  const body = readTextFile(file);
  if (body == null) {
    sendError(res, 404, "not-found", `no such file: ${relPath}`);
    return false;
  }
  send(res, 200, body, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  return true;
}

interface InboxEnvelope {
  id: string;
  from: string;
  to: string[];
  text: string;
  sentAt: string;
  room?: string | null;
  roomSeq?: number | null;
  replyTo?: string | null;
  queuedAt?: string;
  deliveredAt?: string;
  via?: string;
  client?: string;
  /** Which directory it was found in. `read/` means the recipient's session took it. */
  dir: "pending" | "read";
}

/**
 * Read one human's inbox **without draining it**.
 *
 * There is no read-only verb for an inbox: `rooms read --as NAME` is the only
 * way in, and it archives every envelope and stamps `deliveredAt` — that is a
 * write, and the ruling forbids it here. So this reads the envelopes as they sit
 * and passes their fields through verbatim.
 *
 * Two rules keep it honest:
 *
 * - **Only the configured human's own inbox.** The name is not a route
 *   parameter, so there is no `/api/inbox/<someone-else>`. A lane's inbox is
 *   unreachable, which is §2.3's rule preserved for reads as well as writes.
 * - **Nothing is stamped.** In particular no `readAt`: that field means "a screen
 *   showed these bytes" and only `ack`, on the human's instruction, may write it.
 *   This server renders, so it is exactly the party that must not claim the
 *   human read something because it repainted.
 */
function readOwnInbox(inboxRoot: string, name: string): InboxEnvelope[] | null {
  if (!isValidName(name)) return null;
  const root = path.join(inboxRoot, name);
  if (!isDirectory(root)) return [];

  const byId = new Map<string, InboxEnvelope>();

  const collect = (dir: string, tag: "pending" | "read") => {
    for (const entry of readDirNames(dir)) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const raw = readTextFile(path.join(dir, entry));
      if (raw == null) continue;
      let parsed: Partial<InboxEnvelope>;
      try {
        parsed = JSON.parse(raw) as Partial<InboxEnvelope>;
      } catch {
        // A file that does not parse is deleted by the extension's own drain.
        // Rendering it as a mysterious row would be worse than skipping it, but
        // silently skipping hides a real state, so it is counted instead.
        continue;
      }
      if (typeof parsed.id !== "string" || parsed.id.length === 0) continue;
      const envelope: InboxEnvelope = {
        id: parsed.id,
        from: typeof parsed.from === "string" ? parsed.from : "unknown",
        to: Array.isArray(parsed.to) ? parsed.to.filter((t) => typeof t === "string") : [],
        text: typeof parsed.text === "string" ? parsed.text : "",
        sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : "",
        room: typeof parsed.room === "string" ? parsed.room : null,
        roomSeq: typeof parsed.roomSeq === "number" ? parsed.roomSeq : null,
        replyTo: typeof parsed.replyTo === "string" ? parsed.replyTo : null,
        queuedAt: typeof parsed.queuedAt === "string" ? parsed.queuedAt : undefined,
        deliveredAt: typeof parsed.deliveredAt === "string" ? parsed.deliveredAt : undefined,
        via: typeof parsed.via === "string" ? parsed.via : undefined,
        client: typeof parsed.client === "string" ? parsed.client : undefined,
        dir: tag,
      };
      // The `read/` copy is written before `markDelivered` and carries the stamp,
      // so it wins over a pending file with the same id (§5.3's witness).
      const existing = byId.get(envelope.id);
      if (existing == null || (existing.dir === "pending" && tag === "read")) {
        byId.set(envelope.id, envelope);
      }
    }
  };

  collect(root, "pending");
  collect(path.join(root, "read"), "read");

  const out = [...byId.values()];
  out.sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));
  // A recipient's inbox is bounded by the store's own read-history prune; this
  // cap only stops a pathological fixture from blowing up one response.
  return out.slice(-400);
}

export async function startWebServer(options: ServerOptions = {}): Promise<WebServerHandle> {
  const env = options.env ?? process.env;
  const me = options.me != null && options.me.length > 0 ? options.me : null;
  const base = resolveBase(env);
  const paths = resolvePaths(base);

  let activeFollowers = 0;
  /** Live relays, so `close()` can stop them instead of orphaning children. */
  const relays = new Set<{ stop(): void }>();

  const server = createServer((req, res) => {
    // ── Method gate, before routing. ────────────────────────────────────────
    // The reader has no write path, so no method other than GET can do
    // anything. Answering 405 here (rather than in each route) means a route
    // added later cannot accidentally accept a body.
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      sendError(
        res,
        405,
        "read-only",
        `This is a read-only reader: it serves GET and nothing else. ` +
          `Write with \`bin/rooms\` in a terminal.`,
      );
      return;
    }

    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendError(res, 500, "internal", message);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parsing the URL can throw: `new URL` rejects a percent-escape that does not
    // decode to a byte, e.g. `/..%2f..%2f`. That is a bad request, not an
    // internal fault, and answering 500 for it would report this reader as
    // broken when the caller simply sent something that is not a URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${BIND_HOST}`);
    } catch {
      sendError(res, 400, "bad-url", `${JSON.stringify(req.url)} is not a request target this reader can parse.`);
      return;
    }
    const segments = url.pathname.split("/").filter((s) => s.length > 0);

    // ── Static ──────────────────────────────────────────────────────────────
    if (segments.length === 0) {
      serveStatic(res, PUBLIC_DIR, "index.html");
      return;
    }
    if (segments[0] === "vendor") {
      serveStatic(res, VENDOR_DIR, segments.slice(1).join("/"));
      return;
    }
    if (segments[0] !== "api") {
      if (!serveStatic(res, PUBLIC_DIR, segments.join("/"))) return;
      return;
    }

    const api = segments.slice(1);

    // GET /api/config — which store is this, and who is it rendering as.
    //
    // The store path is shown on purpose. "A state belongs to the thing you
    // checked" is a real failure mode here: a client pointed at a temp store
    // looks identical to one pointed at the live fleet, so it says which.
    if (api.length === 1 && api[0] === "config") {
      sendJson(res, 200, {
        ok: true,
        storeBase: base,
        me,
        readOnly: true,
        host: BIND_HOST,
      });
      return;
    }

    // GET /api/rooms — the room list, verbatim from `rooms list --json`.
    if (api.length === 1 && api[0] === "rooms") {
      const result = await readJsonVerb("rooms", [], { env });
      sendJson(res, 200, { ok: true, ...(result as object) });
      return;
    }

    // GET /api/rooms/:room — history plus the receipt ladder.
    if (api.length === 2 && api[0] === "rooms") {
      const room = api[1];
      if (!isValidRoom(room)) {
        sendError(res, 400, "bad-room", `${JSON.stringify(room)} is not a valid room name.`);
        return;
      }
      const result = await readJsonVerb("history", [room], { env });
      const payload = result as {
        room?: { name: string; members: string[] };
        posts?: Array<{ id?: string; recipients?: string[] }>;
      };
      const posts = payload.posts ?? [];
      const receipts: Record<string, RecipientDelivery[]> = {};
      for (const post of posts) {
        if (typeof post.id !== "string" || post.id.length === 0) continue;
        // Room posts are already public in `rooms/<room>/log.jsonl`, so the
        // inbox witness leaks nothing the room log does not contain.
        receipts[post.id] = receiptLadder(paths, post.id, post.recipients ?? [], { witness: true });
      }
      sendJson(res, 200, { ok: true, ...(result as object), receipts });
      return;
    }

    // GET /api/rooms/:room/stream?since=N — the relay, as SSE.
    if (api.length === 3 && api[0] === "rooms" && api[2] === "stream") {
      const room = api[1];
      try {
        assertRoom(room);
        assertSince(url.searchParams.get("since"));
      } catch (error) {
        const relayError = error as RelayError;
        sendError(res, 400, relayError.kind ?? "bad-request", relayError.message);
        return;
      }
      if (activeFollowers >= MAX_FOLLOWERS) {
        sendError(res, 503, "busy", `Already streaming to ${MAX_FOLLOWERS} readers.`);
        return;
      }

      const relay = followRoom(room, url.searchParams.get("since"), { env });
      activeFollowers += 1;
      relays.add(relay);

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      /**
       * Protocol lines are forwarded **verbatim**: the `data:` payload is the
       * child's line byte for byte. The relay does not re-serialise them,
       * because a re-serialised object is a place a field can be dropped or a
       * sequence number can be recomputed (§4, §5.4).
       */
      const forwardRaw = (raw: string) => {
        if (res.writableEnded) return;
        res.write(`event: rooms\ndata: ${raw}\n\n`);
      };
      const sendMeta = (event: string, data: unknown) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendMeta("relay", {
        phase: "hello",
        room,
        since: Number(url.searchParams.get("since") ?? 0),
        pid: relay.pid ?? null,
        readOnly: true,
      });

      relay.onLine((line) => {
        forwardRaw(line);
        // Derived state rides in its own frame so the protocol line stays
        // untouched. Only posts have receipts; gaps have nothing to say here.
        let parsed: { type?: string; id?: string; recipients?: string[] };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          return;
        }
        if (parsed.type !== "post" || typeof parsed.id !== "string") return;
        sendMeta("receipts", {
          id: parsed.id,
          deliveries: receiptLadder(paths, parsed.id, parsed.recipients ?? [], { witness: true }),
        });
      });

      relay.onExit((exit) => {
        activeFollowers = Math.max(0, activeFollowers - 1);
        relays.delete(relay);
        // §5.5 criterion 5: the browser must be able to say *which* failure.
        sendMeta("relay", {
          phase: "end",
          code: exit.code,
          signal: exit.signal,
          stderr: exit.stderr,
          ok: exit.code === 0 && exit.signal == null,
        });
        if (!res.writableEnded) res.end();
      });

      // A keep-alive comment every 15s. SSE comments are ignored by the client
      // and keep a browser from treating an idle room as a dead connection.
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        res.write(": keep-alive\n\n");
      }, 15_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        relays.delete(relay);
        relay.stop();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }

    // GET /api/participants — records plus presence, both verbatim.
    if (api.length === 1 && api[0] === "participants") {
      const [participants, presence] = await Promise.all([
        readJsonVerb("participants", [], { env }),
        readJsonVerb("presence", [], { env }),
      ]);
      sendJson(res, 200, {
        ok: true,
        participants: (participants as { participants?: unknown }).participants ?? [],
        presence: (presence as { presence?: unknown }).presence ?? [],
      });
      return;
    }

    // GET /api/inbox — the configured human's own envelope list, undrained.
    if (api.length === 1 && api[0] === "inbox") {
      if (me == null) {
        sendError(
          res,
          400,
          "no-identity",
          `Start the server with --me NAME to read that human's inbox. ` +
            `The inbox name is a startup setting, not a route parameter, so this ` +
            `reader can never be pointed at another name's mail.`,
        );
        return;
      }
      const envelopes = readOwnInbox(paths.inbox, me);
      if (envelopes == null) {
        sendError(res, 400, "bad-name", `${JSON.stringify(me)} is not a valid rooms name.`);
        return;
      }
      const receipts: Record<string, RecipientDelivery[]> = {};
      for (const envelope of envelopes) {
        // A DM's body is not public, so the ladder uses the receipt only: this
        // client has no business reading a third party's inbox to render one.
        receipts[envelope.id] = receiptLadder(paths, envelope.id, [me], { witness: false });
      }
      sendJson(res, 200, { ok: true, me, messages: envelopes, receipts });
      return;
    }

    sendError(res, 404, "not-found", `no route for ${url.pathname}`);
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, BIND_HOST, () => {
      const address = server.address();
      resolve(typeof address === "object" && address != null ? address.port : 0);
    });
  });

  const url = `http://${BIND_HOST}:${port}/`;
  if (!options.silent) {
    process.stdout.write(
      `pi-rooms web reader → ${url}\n` +
        `  store: ${base}${base === resolveBase({}) ? "" : "  (PI_ROOMS_DIR override)"}\n` +
        `  read-only: GET only, no write verb reachable\n` +
        `  ${me != null ? `reading ${me}'s inbox undrained` : "no --me, so no inbox route"}\n`,
    );
  }

  return {
    port,
    url,
    async close() {
      for (const relay of relays) relay.stop();
      relays.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `npm run web` entry point. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let port = 0;
  let me: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--me" || arg === "-m") {
      me = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--me=")) {
      me = arg.slice("--me=".length);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: npm run web -- [--port N] [--me NAME]\n\n" +
          "  --port N   listen on 127.0.0.1:N (default 0, an OS-chosen free port)\n" +
          "  --me NAME  the human this client renders for. Used for own-vs-other\n" +
          "             authorship and to read that name's inbox WITHOUT draining it.\n" +
          "             It never reaches a child's argv and writes no presence lease.\n",
      );
      return;
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`--port takes a whole number between 0 and 65535.\n`);
    process.exit(2);
  }
  await startWebServer({ port, me: me ?? undefined });
}

// Only auto-start when run directly, so importing this module in a test is free.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
