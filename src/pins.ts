/**
 * pi-rooms — name pins.
 *
 * `PI_ROOMS_NAME` can only be set before a process starts, so pinning a running
 * fleet that way means restarting every lane. A pin file lets an operator assign
 * durable names to lanes that are already up.
 *
 * Precedence, highest first:
 *
 * 1. `PI_ROOMS_NAME` / `PI_AGENT_NAME` in the environment — an explicit,
 *    per-process instruction always wins, and a pin never overrides it.
 * 2. a pin on `session:<PI_SESSION_ID>` — stable across restarts of that session.
 * 3. a pin on `pane:<HERDR_PANE_ID>` — what an operator can see in the UI, but
 *    recycled by herdr, so only usable while the pane hosts the same process.
 * 4. a pin on `cwd:<absolute path>` — stable and easily expressed, but cannot
 *    distinguish two lanes sharing one directory.
 *
 * 2 before 3 is deliberate: a session id survives the pane being moved, closed or
 * recreated, while a pane id does not survive anything. Pinning by pane is the
 * convenient option, not the durable one, and the two are ordered accordingly.
 *
 * Validity. A pin recorded with a proc identity (`<starttime>`) is only honoured
 * while the process matches it. That is what stops an operator's pin for a lane
 * in `wE:p1B` from being inherited by whatever process next occupies `wE:p1B`.
 * A pin recorded without one — a fresh entry the operator typed by hand — is
 * applied to whoever claims it next and then stamped with that process.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isValidName, listAgents, procIdentity, slugify, type Paths } from "./store.ts";

export interface PinEntry {
  name: string;
  /** Proc identity the pin was claimed by, when it has been used. */
  procId?: string;
  /** Operator note, ignored by the resolver. */
  note?: string;
}

export interface PinFile {
  /** Pin keys to names, e.g. `"pane:wE:p1B": { "name": "dxdb-core" }`. */
  pins: Record<string, PinEntry>;
}

export interface ResolveContext {
  sessionId?: string;
  paneId?: string;
  cwd: string;
  pid: number;
}

export interface ResolvedPin {
  name: string;
  key: string;
  /** True when the entry was stamped with this process on this call. */
  claimed: boolean;
  /** Set when a pin existed for a higher-priority key but was rejected. */
  rejected?: { key: string; reason: string };
}

/**
 * How many other live agents share a directory.
 *
 * A `cwd:` pin carries no way to say *which* lane in a directory it means, so it
 * is only safe where the answer is unambiguous. This is the count that decides
 * that, excluding the asking process.
 */
export function otherAgentsInCwd(paths: Paths, cwd: string, pid: number): number {
  return listAgents(paths).filter((a) => a.cwd === cwd && a.pid !== pid).length;
}

/**
 * Whether a `cwd:` pin is unambiguous for this process.
 *
 * Counts every live pi process whose cwd is this directory, not only the ones
 * that have registered with pi-rooms. A directory serving two pi panes is
 * ambiguous even while the other pane has not joined yet — and a pin read before
 * the second lane joins would otherwise be honoured, then silently become
 * ambiguous the moment it did. `process.cwd()` is only ever an approximation
 * here, so the registered roster is still consulted as well.
 */
export function cwdIsAmbiguous(paths: Paths, cwd: string, pid: number): boolean {
  if (otherAgentsInCwd(paths, cwd, pid) > 0) return true;
  return unregisteredPanesIn(cwd, pid) > 1;
}

function unregisteredPanesIn(cwd: string, pid: number): number {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  let count = 1; // this process
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const other = Number(entry);
    if (other === pid) continue;
    let link: string;
    try {
      link = fs.readlinkSync(`/proc/${other}/cwd`);
    } catch {
      continue;
    }
    if (link !== cwd) continue;
    // Only counted when it looks like another pi session in the same place.
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${other}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (cmdline.includes("pi") && !cmdline.includes("pi-rooms")) count += 1;
  }
  return count;
}

export function pinPath(paths: Paths): string {
  return path.join(paths.base, "names.json");
}

export function readPinFile(paths: Paths): PinFile {
  let raw: string;
  try {
    raw = fs.readFileSync(pinPath(paths), "utf8");
  } catch {
    return { pins: {} };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { pins: {} };
    const pins = (parsed as { pins?: unknown }).pins;
    if (typeof pins !== "object" || pins === null) return { pins: {} };
    return { pins: pins as Record<string, PinEntry> };
  } catch {
    // A malformed pin file must not stop a session registering; it falls back to
    // the derived name, and `rooms_who` will show that the pin is not in effect.
    return { pins: {} };
  }
}

export function writePinFile(paths: Paths, file: PinFile): void {
  fs.mkdirSync(paths.base, { recursive: true });
  const tmp = `${pinPath(paths)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, pinPath(paths));
}

/** The keys that could apply to this process, highest priority first. */
export function candidateKeys(ctx: ResolveContext): string[] {
  const keys: string[] = [];
  if (ctx.sessionId != null && ctx.sessionId.length > 0) keys.push(`session:${ctx.sessionId}`);
  if (ctx.paneId != null && ctx.paneId.length > 0) keys.push(`pane:${ctx.paneId}`);
  if (ctx.cwd.length > 0) keys.push(`cwd:${ctx.cwd}`);
  return keys;
}

/**
 * Find the pin that applies to this process, if any.
 *
 * Does not mutate: the caller decides whether to stamp the claim.
 */
export function resolvePin(paths: Paths, ctx: ResolveContext): ResolvedPin | null {
  const file = readPinFile(paths);
  const current = procIdentity(ctx.pid);
  let rejected: { key: string; reason: string } | undefined;
  for (const key of candidateKeys(ctx)) {
    const entry = file.pins[key];
    if (entry == null || typeof entry.name !== "string") continue;
    if (!isValidName(entry.name)) {
      rejected = rejected ?? {
        key,
        reason: `"${entry.name}" is not a valid name (lowercase letters, digits, dash, underscore)`,
      };
      continue;
    }
    // A cwd pin cannot distinguish two lanes in one directory, so honouring it
    // there would silently decide which lane keeps its name. Refuse instead of
    // guessing: the operator gets a reason and can pin by session or pane.
    if (key.startsWith("cwd:") && cwdIsAmbiguous(paths, ctx.cwd, ctx.pid)) {
      rejected = rejected ?? {
        key,
        reason:
          "cwd pin ignored: another agent shares this directory, so the pin is ambiguous " +
          "(pin by session: or pane: instead)",
      };
      continue;
    }
    // A pin claimed by a different process has been inherited by this one: the
    // pane or session key now belongs to someone else.
    if (entry.procId != null && current != null && entry.procId !== current) {
      rejected = rejected ?? { key, reason: "pin was claimed by a different process" };
      continue;
    }
    return { name: entry.name, key, claimed: entry.procId == null, rejected };
  }
  return rejected == null ? null : { name: "", key: "", claimed: false, rejected };
}

/**
 * Apply the pin for this process, stamping it as claimed on first use.
 *
 * Returns the name, or null when no pin applies. An existing pin keeps its
 * timestamp so a restart of the same process does not rewrite the file.
 */
export function claimPin(paths: Paths, ctx: ResolveContext): ResolvedPin | null {
  const resolved = resolvePin(paths, ctx);
  if (resolved == null || resolved.name.length === 0) return resolved;
  if (!resolved.claimed) return resolved;

  const file = readPinFile(paths);
  const entry = file.pins[resolved.key];
  if (entry == null) return { ...resolved, claimed: false };
  const current = procIdentity(ctx.pid);
  const slug = slugify(resolved.name);
  file.pins[resolved.key] = { ...entry, name: slug, procId: current ?? undefined };
  writePinFile(paths, file);
  // `claimed` stays true: this call is the one that bound the pin to this
  // process, and a caller that needs to know whether a claim happened (to log
  // it, or to warn about a pin it just consumed) cannot infer it afterwards.
  return { ...resolved, name: slug, claimed: true };
}

/** Release a pin claimed by a dead process, so the next occupant can use it. */
export function releaseStalePin(paths: Paths, key: string): boolean {
  const file = readPinFile(paths);
  const entry = file.pins[key];
  if (entry == null) return false;
  if (entry.procId == null) return false;
  delete file.pins[key];
  writePinFile(paths, file);
  return true;
}

/** Every pin, with the name it resolves to. For diagnostics. */
export function listPins(paths: Paths): Array<{ key: string; name: string; claimed: boolean; valid: boolean }> {
  const file = readPinFile(paths);
  return Object.entries(file.pins)
    .map(([key, entry]) => ({
      key,
      name: entry.name,
      claimed: entry.procId != null,
      valid: isValidName(entry.name),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
