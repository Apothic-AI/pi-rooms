/**
 * Config tests. The limiter is opt-in, so the defaults carry real weight:
 * a missing or malformed config must never silently throttle an agent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULTS, loadConfig, configPath } from "../src/config.ts";
import { resolvePaths } from "../src/store.ts";

function tempPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-cfg-"));
  return resolvePaths(base);
}

function write(paths: ReturnType<typeof tempPaths>, value: unknown) {
  fs.writeFileSync(configPath(paths), JSON.stringify(value));
}

test("no config file means no cap", () => {
  const paths = tempPaths();
  const config = loadConfig(paths);
  assert.equal(config.maxSendsPerSession, null);
  assert.deepEqual(config, DEFAULTS);
});

test("an empty object still means no cap", () => {
  const paths = tempPaths();
  write(paths, {});
  assert.equal(loadConfig(paths).maxSendsPerSession, null);
});

test("malformed JSON falls back to defaults instead of failing the session", () => {
  const paths = tempPaths();
  fs.writeFileSync(configPath(paths), "{ not json");
  assert.deepEqual(loadConfig(paths), DEFAULTS);
});

test("a positive cap is honoured", () => {
  const paths = tempPaths();
  write(paths, { maxSendsPerSession: 5 });
  assert.equal(loadConfig(paths).maxSendsPerSession, 5);
});

test("zero, negative, null and junk all mean unbounded", () => {
  const paths = tempPaths();
  for (const value of [0, -1, null, "12", {}, NaN]) {
    write(paths, { maxSendsPerSession: value });
    assert.equal(loadConfig(paths).maxSendsPerSession, null, `${JSON.stringify(value)} is unbounded`);
  }
});

test("delivery modes default to steer for DMs and followUp for rooms", () => {
  const paths = tempPaths();
  const config = loadConfig(paths);
  assert.equal(config.dmDelivery, "steer");
  assert.equal(config.roomDelivery, "followUp");
});

test("delivery modes accept only known values", () => {
  const paths = tempPaths();
  write(paths, { dmDelivery: "shout", roomDelivery: "steer" });
  const config = loadConfig(paths);
  assert.equal(config.dmDelivery, "steer", "unknown value falls back");
  assert.equal(config.roomDelivery, "steer");
});

test("autoJoin can be turned off", () => {
  const paths = tempPaths();
  write(paths, { autoJoin: false });
  assert.equal(loadConfig(paths).autoJoin, false);
});
