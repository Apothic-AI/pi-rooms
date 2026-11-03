/**
 * The web client's entire filesystem capability.
 *
 * This file exists so that "read-only by construction" is a property of the
 * module graph rather than a promise in a comment. Nothing else under `web/`
 * imports `node:fs`; everything that needs a byte from the store comes through
 * one of the four readers below. There is no `writeFile`, no `mkdir`, no
 * `rename`, no `unlink` — not a disabled one, not a flag-gated one. Absent.
 *
 * The distinction matters because the design's reason for existing is "no
 * daemon, no server, no database" (`README.md:4`). The loopback relay that
 * serves this client is allowed to exist because it is a *reader*: it holds no
 * state, owns no protocol, and cannot write even if it were compromised. If a
 * future change needs a write verb in the browser, that is a new decision — the
 * operator's words — and adding a function here is where it would have to start,
 * which is why this file is four functions long and not a wrapper.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A file's contents, or `null` when it is absent or unreadable.
 *
 * Returning `null` rather than throwing is deliberate: a missing receipt file
 * and a receipt file we were not allowed to read are both *unknown receipt*, and
 * §5.3's rule is that unknown is never rendered as "not delivered". Collapsing
 * them into one silent `null` at this layer means no caller can accidentally
 * turn an I/O error into a delivery claim.
 */
export function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Directory entries, or `[]` when the directory is absent. Read-only. */
export function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** True when `file` exists and is a regular file. Never follows into a directory. */
export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** True when `dir` exists and is a directory. */
export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve `candidate` inside `root`, or `null` when it escapes.
 *
 * The static-file route is the only place a URL segment reaches a path, so this
 * is the single traversal gate. `path.resolve` first normalises `..`, then the
 * prefix test is done against `root + sep` so that `/srv/webb` cannot pass as a
 * child of `/srv/web`.
 */
export function resolveInside(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  if (resolved === resolvedRoot) return resolved;
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}
