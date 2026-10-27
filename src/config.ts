/**
 * pi-rooms — configuration.
 *
 * Read from `<base>/config.json`. Every field is optional; a missing or
 * malformed file yields the defaults below rather than failing the session,
 * because a broken config must not take an agent's messaging offline.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Paths } from "./store.ts";

export type DeliveryMode = "steer" | "followUp";

export interface RoomsConfig {
  /** Join the registry automatically on session start. */
  autoJoin: boolean;
  /**
   * Outbound messages one session may send before the tool refuses.
   *
   * `null` — the default — means unbounded: no cap is applied unless the
   * operator sets one. When set, the cap is structural rather than advice, so
   * two agents cannot volley past it and widening it is a deliberate config
   * edit. Set it per fleet, not per agent.
   */
  maxSendsPerSession: number | null;
  /** How a direct message interrupts the receiver. */
  dmDelivery: DeliveryMode;
  /** How a room post interrupts the receiver. */
  roomDelivery: DeliveryMode;
  /** Inbox fallback poll interval, for filesystems where watch is unreliable. */
  pollMs: number;
}

export const DEFAULTS: RoomsConfig = {
  autoJoin: true,
  maxSendsPerSession: null,
  dmDelivery: "steer",
  roomDelivery: "followUp",
  pollMs: 2000,
};

export function configPath(paths: Paths): string {
  return path.join(paths.base, "config.json");
}

export function loadConfig(paths: Paths): RoomsConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(paths), "utf8");
  } catch {
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };
  const input = parsed as Record<string, unknown>;
  const delivery = (value: unknown, fallback: DeliveryMode): DeliveryMode =>
    value === "steer" || value === "followUp" ? value : fallback;
  const number = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  // A missing, zero, negative or non-numeric cap means unbounded. Only an
  // explicit positive number turns the limiter on.
  const cap = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  return {
    autoJoin: input.autoJoin === false ? false : DEFAULTS.autoJoin,
    maxSendsPerSession: cap(input.maxSendsPerSession),
    dmDelivery: delivery(input.dmDelivery, DEFAULTS.dmDelivery),
    roomDelivery: delivery(input.roomDelivery, DEFAULTS.roomDelivery),
    pollMs: number(input.pollMs, DEFAULTS.pollMs),
  };
}
