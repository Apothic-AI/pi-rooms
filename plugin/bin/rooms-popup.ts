#!/usr/bin/env node
/**
 * The popup entrypoint: argv in, a full-screen reader out.
 *
 * This is the only file in `plugin/` that touches `process`. Everything below it
 * is pure or explicitly-injected, which is what lets the states be tested
 * without a terminal.
 *
 * Usage (the manifest passes these; a human can too):
 *
 *   rooms-popup --as NAME          whose mail the inbox shows, and who `ack` acts as
 *   rooms-popup --room NAME        open straight onto a room
 *   rooms-popup --json             print the snapshot as JSON and exit, writing nothing
 *
 * It reads `PI_ROOMS_DIR` for the store root exactly as `bin/rooms` does, so a
 * popup can be pointed at a temp store for a test with no other change.
 */

import { readSnapshot, readInbox, storePaths } from "../src/reader.ts";
import { render } from "../src/render.ts";
import { initialSnapshotFor } from "../src/model.ts";
import { motionEnabled } from "../src/theme.ts";
import { run } from "../src/tui.ts";

interface Args {
  identity: string | null;
  room: string | null;
  json: boolean;
  width: number;
  height: number;
  help: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    identity: (process.env.PI_ROOMS_AS ?? "").trim() || null,
    room: (process.env.PI_ROOMS_ROOM ?? "").trim() || null,
    json: false,
    width: 100,
    height: 34,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next == null) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--as":
        args.identity = value();
        break;
      case "--room":
        args.room = value();
        break;
      case "--json":
        args.json = true;
        break;
      case "--width":
        args.width = Number(value());
        break;
      case "--height":
        args.height = Number(value());
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return args;
}

const HELP = `rooms-popup — a herdr popup that shows pi-rooms and writes nothing

usage:
  rooms-popup --as NAME [--room R]   open the reader
  rooms-popup --as NAME --json       print the snapshot and exit

environment:
  PI_ROOMS_DIR    store root (default ~/.pi/agent/rooms)
  PI_ROOMS_AS     default for --as
  NO_MOTION=1     drop the arrival animation; same information, no movement
  REDUCED_MOTION=1  same as NO_MOTION

keys:
  ↑ ↓ select · a ack (y/n to confirm) · ctrl-d/u scroll · r re-read · ? help · q quit

drafts are staged in memory only. The plugin writes no file of its own; the one
write it can cause is \`rooms ack\`, on an explicit y, because readAt means "a
screen showed these bytes" and only a client can say that.
`;

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`rooms-popup: ${(error as Error).message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  if (args.json) {
    const snapshot = readSnapshot(process.env, args.identity);
    process.stdout.write(
      `${JSON.stringify(
        {
          ...snapshot,
          inbox: args.identity == null ? [] : readInbox(storePaths(process.env), args.identity),
          base: storePaths(process.env).base,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  // Not a TTY — a pipe, a test, a `--json`-less script. Render one frame to
  // stdout instead of trying to take over a terminal that is not there. This is
  // what makes the four states reachable from a test.
  if (!process.stdout.isTTY) {
    const state = initialSnapshotFor(args.identity, readSnapshot(process.env, args.identity));
    const lines = render(state, {
      cols: args.width,
      rows: args.height,
      now: Date.now(),
      motion: motionEnabled(process.env),
      tick: 0,
    });
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  await run({ identity: args.identity, env: process.env });
}

await main();
