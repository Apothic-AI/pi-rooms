/**
 * Text measurement and styling.
 *
 * A terminal frame is a grid of cells, so everything here counts *cells*, not
 * bytes and not UTF-16 units. The one thing this file will not do is guess
 * badly: characters outside the common ranges are counted as one cell except
 * for the wide blocks listed below, which are counted as two.
 */

import { COLOR, TYPE, type ColorName, type TypeName } from "./theme.ts";

const ESC = "\u001b[";
const ANSI = /\u001b\[[0-9;]*m/g;

/** Apply a named size and, optionally, a named colour. */
export function style(text: string, type: TypeName, color?: ColorName): string {
  const attributes = TYPE[type] as readonly string[];
  let prefix = "";
  for (const attribute of attributes) {
    const code =
      attribute === "bold" ? 1
      : attribute === "dim" ? 2
      : attribute === "italic" ? 3
      : attribute === "underline" ? 4
      : null;
    if (code != null) prefix += `${ESC}${code}m`;
  }
  if (color != null) prefix += `${ESC}38;5;${COLOR[color]}m`;
  if (prefix.length === 0) return text;
  return `${prefix}${text}\u001b[0m`;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Display width in cells. */
export function width(text: string): number {
  let total = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x200b || (code >= 0x0300 && code <= 0x036f)) continue;
    total += isWide(code) ? 2 : 1;
  }
  return total;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** The marker used when an identifier is clipped. Prose is never clipped. */
export const ELLIPSIS = "…";

/**
 * Fit a styled string into exactly `cells` cells.
 *
 * Used only for the ident face (names, ids, timestamps). Prose goes through
 * {@link wrap} instead, because clipping a sentence loses the end of a message
 * and there is no marker that makes that acceptable.
 */
export function fit(text: string, cells: number, align: "left" | "right" = "left"): string {
  const visible = width(text);
  if (visible > cells) {
    const plain = stripAnsi(text);
    if (cells <= 0) return "";
    let kept = "";
    let used = 0;
    for (const char of plain) {
      const charWidth = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
      if (used + charWidth > cells - 1) break;
      kept += char;
      used += charWidth;
    }
    return `${kept}${ELLIPSIS}`;
  }
  const pad = " ".repeat(cells - visible);
  return align === "left" ? `${text}${pad}` : `${pad}${text}`;
}

/**
 * Wrap prose to `cells` cells.
 *
 * Words longer than a line are hard-broken rather than allowed to overflow: a
 * long URL or an unbroken id would otherwise wrap at the terminal's own margin
 * and break the column the message is supposed to sit in.
 */
export function wrap(text: string, cells: number): string[] {
  if (cells <= 0) return [""];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (word.length === 0) continue;
      if (/^\s+$/.test(word)) {
        if (line.length > 0) line += " ";
        continue;
      }
      if (width(line) + width(word) <= cells) {
        line += word;
        continue;
      }
      if (line.length > 0) {
        out.push(line.trimEnd());
        line = "";
      }
      let rest = word;
      while (width(rest) > cells) {
        let take = "";
        let used = 0;
        for (const char of rest) {
          const charWidth = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
          if (used + charWidth > cells) break;
          take += char;
          used += charWidth;
        }
        out.push(take);
        rest = rest.slice(take.length);
      }
      line = rest;
    }
    out.push(line.trimEnd());
  }
  return out.length === 0 ? [""] : out;
}

/** A horizontal rule that ends exactly at `cells`. */
export function rule(cells: number, char = "─"): string {
  return char.repeat(Math.max(0, cells));
}

/** Pad a visible string to `cells` cells (no clipping; caller fits first). */
export function pad(text: string, cells: number): string {
  const visible = width(text);
  return visible >= cells ? text : `${text}${" ".repeat(cells - visible)}`;
}
