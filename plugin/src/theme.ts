/**
 * The design system for the rooms popup.
 *
 * Three scales, each small enough to hold in your head and each the *only*
 * source of its kind in this plugin:
 *
 *   TYPE   five sizes, named for the job rather than the point size.
 *   SPACE  one base unit. Every column start and every section gap is a
 *          multiple of it, so the popup has a grid instead of an accumulation
 *          of one-off padding.
 *   COLOR  every entry names the state it encodes. There is no "accent" that
 *          is merely pretty: a colour that does not name a state does not
 *          exist here. That is criterion 4 of the brief made structural — the
 *          renderer can only emit codes drawn from this table, which a test
 *          asserts.
 *
 * Two faces, because a terminal has one font but two kinds of text:
 *
 *   FACE.prose  free-flowing message text, wrapped to the column.
 *   FACE.ident  names, ids and timestamps, set in fixed-width columns so they
 *               line up character for character down the page.
 *
 * A "size" in a terminal cannot be a point size, so it is a weight/attribute
 * combination applied consistently. The renderer never emits a bare attribute;
 * it asks for a type name and gets the attributes for it.
 */

/** The single spacing unit, in terminal cells. */
export const SPACE = 4;

/**
 * `n` spacing units, in cells or lines.
 *
 * Rejects anything that would put content off the grid, so a fractional or
 * negative gap is a programming error rather than a wobbly pixel.
 */
export function sp(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`sp(n) needs a whole number of units, got ${n}`);
  }
  return n * SPACE;
}

/** Round a free measurement down to the grid, for centred blocks. */
export function snap(n: number): number {
  return Math.max(0, Math.floor(n / SPACE) * SPACE);
}

/** SGR attributes per size. Five entries; the renderer uses no others. */
export const TYPE = {
  /** The screen's own name. One per popup, and the only underlined thing. */
  display: ["bold", "underline"],
  /** A section head: ROOMS, HUMANS, a room's title, a state block's title. */
  title: ["bold"],
  /** Prose: message text and names in running copy. */
  body: [],
  /** Metadata: ids, timestamps, counts, causes. */
  meta: ["dim"],
  /** The key legend and other furniture the eye should skip. */
  micro: ["dim", "italic"],
} as const;

export type TypeName = keyof typeof TYPE;

/**
 * The two faces. `prose` wraps; `ident` is set in columns and clipped with the
 * truncation marker rather than rewrapped.
 */
export const FACE = {
  prose: "wrap",
  ident: "column",
} as const;

export type FaceName = keyof typeof FACE;

/**
 * Colour names, each stating the state it encodes.
 *
 * The presence entries are words, not dots. A human's state is a lease their
 * own client wrote and that expires on read, so it is rendered as
 * "away · declared 23m ago" and never as a filled marker that reads as
 * "this person is here now".
 */
export const COLOR = {
  /* ---- delivery, the ladder after queueing ---- */
  /** A file exists in the recipient's inbox; nothing has observed it. */
  queued: 244,
  /** A recipient's session, or the read copy, evidences the bytes left the queue. */
  delivered: 75,
  /** A client rendered it to a human. Only `ack` writes this. */
  read: 114,
  /** No receipt and no copy. Unknown is not a failure, and must not look like one. */
  unknown: 179,
  /** A real failure: a child died, the store cannot be read, a command refused. */
  error: 203,
  /** A break in the stream: posts are missing and the plugin will not invent them. */
  gap: 179,

  /* ---- who wrote it ---- */
  /** This client's own name. */
  own: 141,
  /** An agent. */
  agent: 252,
  /** A human participant. */
  human: 183,

  /* ---- where it was said ---- */
  room: 110,
  dm: 180,

  /* ---- presence: four words, four colours, no marker glyph ---- */
  presence_online: 114,
  presence_away: 179,
  presence_offline: 244,
  presence_unknown: 245,

  /* ---- structure ---- */
  /** Rules and the vertical separator. */
  rule: 238,
  /** Secondary text that is not a state. */
  dim: 245,
} as const;

export type ColorName = keyof typeof COLOR;

/** Motion, in ticks of 60 ms. Dropped entirely under reduced motion. */
export const MOTION = {
  /** How long a newly arrived row keeps its arrival bar. */
  arrivalTicks: 5,
  tickMs: 60,
  /** Ticks the rail/stream spacer animates on a room switch. None: no sliding. */
  switchTicks: 0,
} as const;

/**
 * Whether motion is allowed.
 *
 * Reduced motion is a first-class path, not a degradation: the same information
 * is rendered, only without movement. `TERM=dumb` counts as reduced motion
 * because a dumb terminal cannot be trusted with cursor work.
 */
export function motionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const off = (value: string | undefined) => value != null && /^(1|true|yes|on)$/i.test(value.trim());
  if (off(env.NO_MOTION) || off(env.REDUCED_MOTION)) return false;
  if ((env.TERM ?? "").trim() === "dumb") return false;
  return true;
}

/** Every SGR sequence this plugin is allowed to emit, for the palette test. */
export function allowedSgr(): Set<string> {
  const out = new Set<string>(["\u001b[0m"]);
  for (const color of Object.values(COLOR)) out.add(`\u001b[38;5;${color}m`);
  const attributes = new Set(Object.values(TYPE).flat());
  for (const attribute of attributes) {
    const code =
      attribute === "bold" ? 1
      : attribute === "dim" ? 2
      : attribute === "italic" ? 3
      : attribute === "underline" ? 4
      : null;
    if (code != null) out.add(`\u001b[${code}m`);
  }
  return out;
}

/** Column widths, all multiples of {@link SPACE}. */
export const COLUMNS = {
  /** The left rail: rooms and humans. */
  rail: sp(6),
  /** Marker / gutter cell, and the indent of wrapped prose under it. */
  gutter: sp(1),
  /** `#12` and friends. */
  seq: sp(1),
  /** `22:04` plus its trailing space. */
  time: sp(2),
  /** Author names, set in the ident face. */
  author: sp(3),
} as const;
