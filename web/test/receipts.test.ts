/**
 * The delivery ladder — §5.3's witness rule, mechanised.
 *
 * The failure this file exists to prevent is the one the brief calls out as the
 * easiest thing in the client to get wrong: reading an absent `deliveredAt` as
 * "not delivered", and re-sending mail that already arrived. The store writes
 * the `read/` copy *before* `markDelivered`, so a crash between them leaves a
 * receipt that has lost its stamp and an inbox copy that still has it.
 *
 * Every test reads the artifact and asserts a state, not an exit code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { describeDelivery, receiptLadder, stateOf } from "../server/receipts.ts";
import { OPERATOR, OTHER, seed, tempStore } from "./fixture.ts";

test("an absent deliveredAt with a read/ copy is delivered, never 'not delivered'", () => {
  const store = tempStore();
  try {
    const { witnessId } = seed(store);
    const ladder = receiptLadder(store.paths, witnessId, [OPERATOR]);
    assert.equal(ladder.length, 1);
    const entry = ladder[0];

    // The receipt has no deliveredAt — that is the whole point of the fixture.
    const receipt = JSON.parse(
      fs.readFileSync(path.join(store.paths.receipts, `${witnessId}.json`), "utf8"),
    );
    assert.equal(receipt.receipts[OPERATOR].deliveredAt, undefined, "fixture must have lost the stamp");

    // And yet the ladder says delivered, because the copy is the witness.
    assert.equal(entry.state, "delivered");
    assert.equal(entry.witness, "read-copy");
    assert.notEqual(entry.deliveredAt, null);
    assert.match(describeDelivery(entry), /the inbox copy is the witness/);
  } finally {
    store.cleanup();
  }
});

test("stateOf has no branch that produces 'not delivered'", () => {
  // The weakest answer available is `unknown`. Exhaustive over the meaningful
  // combinations of the three stamps, so a new field cannot quietly add a
  // "failed" state without this failing.
  assert.equal(stateOf({ queuedAt: null, deliveredAt: null, readAt: null }), "unknown");
  assert.equal(stateOf({ queuedAt: "t", deliveredAt: null, readAt: null }), "queued");
  assert.equal(stateOf({ queuedAt: "t", deliveredAt: "t", readAt: null }), "delivered");
  assert.equal(stateOf({ queuedAt: "t", deliveredAt: "t", readAt: "t" }), "read");
  // readAt alone still means a human saw it, even if earlier stamps are gone.
  assert.equal(stateOf({ queuedAt: null, deliveredAt: null, readAt: "t" }), "read");

  const everyState = new Set<string>();
  for (const queuedAt of [null, "t"]) {
    for (const deliveredAt of [null, "t"]) {
      for (const readAt of [null, "t"]) {
        everyState.add(stateOf({ queuedAt, deliveredAt, readAt }));
      }
    }
  }
  assert.deepEqual(
    [...everyState].sort(),
    ["delivered", "queued", "read", "unknown"],
    "the ladder is exactly four rungs, and 'not delivered' is not one of them",
  );
});

test("unknown is worded as the absence of a claim, not as a failure", () => {
  const store = tempStore();
  try {
    const { unknownId } = seed(store);
    const [entry] = receiptLadder(store.paths, unknownId, [OPERATOR]);
    assert.equal(entry.state, "unknown");
    assert.equal(entry.witness, "none");
    const words = describeDelivery(entry);
    assert.match(words, /nothing was claimed either way/);
    // No failure vocabulary anywhere in the unknown wording.
    for (const word of ["fail", "lost", "error", "did not arrive", "not delivered"]) {
      assert.ok(!words.toLowerCase().includes(word), `unknown must not say "${word}"`);
    }
  } finally {
    store.cleanup();
  }
});

test("queued is not worded as a failure either", () => {
  const store = tempStore();
  try {
    const { queuedId } = seed(store);
    const [entry] = receiptLadder(store.paths, queuedId, [OPERATOR]);
    assert.equal(entry.state, "queued");
    assert.match(describeDelivery(entry), /not the same as not delivered/);
  } finally {
    store.cleanup();
  }
});

test("delivered from the receipt itself reports witness=receipt", () => {
  const store = tempStore();
  try {
    const { deliveredId } = seed(store);
    const [entry] = receiptLadder(store.paths, deliveredId, [OPERATOR]);
    assert.equal(entry.state, "delivered");
    assert.equal(entry.witness, "receipt");
    assert.match(describeDelivery(entry), /session was handed it/);
  } finally {
    store.cleanup();
  }
});

test("read comes only from ack's readAt, and outranks delivered", () => {
  const store = tempStore();
  try {
    const { readId } = seed(store);
    const [entry] = receiptLadder(store.paths, readId, [OPERATOR], { witness: false });
    assert.equal(entry.state, "read");
    assert.notEqual(entry.readAt, null);
    assert.match(describeDelivery(entry), /acknowledged/);
  } finally {
    store.cleanup();
  }
});

test("a DM ladder does not read a third party's inbox", () => {
  const store = tempStore();
  try {
    const { witnessId } = seed(store);
    // With the witness disabled — what a DM route does — the lost receipt stamp
    // is not recoverable, so the honest answer is `queued`, not a fabricated
    // `delivered` and not a fabricated failure.
    const [entry] = receiptLadder(store.paths, witnessId, [OPERATOR], { witness: false });
    assert.equal(entry.state, "queued");
    assert.equal(entry.witness, "none");
  } finally {
    store.cleanup();
  }
});

test("an id that is not a message id never becomes a path segment", () => {
  const store = tempStore();
  try {
    seed(store);
    for (const evil of ["../../etc/passwd", "..%2f..%2fetc", "/etc/passwd", "short", ""]) {
      const ladder = receiptLadder(store.paths, evil, [OPERATOR]);
      assert.equal(ladder.length, 1);
      assert.equal(ladder[0].state, "unknown", `"${evil}" must not resolve to a receipt`);
    }
  } finally {
    store.cleanup();
  }
});

test("a recipient name that is not a valid name is never used as a path segment", () => {
  const store = tempStore();
  try {
    const { witnessId } = seed(store);
    const ladder = receiptLadder(store.paths, witnessId, ["../../operator"]);
    assert.equal(ladder[0].state, "unknown");
  } finally {
    store.cleanup();
  }
});

test("the ladder reports every recipient, including one with no receipt", () => {
  const store = tempStore();
  try {
    const { queuedId } = seed(store);
    const ladder = receiptLadder(store.paths, queuedId, [OPERATOR, OTHER]);
    assert.equal(ladder.length, 2);
    assert.deepEqual(ladder.map((l) => l.recipient), [OPERATOR, OTHER]);
    // OTHER's per-recipient receipt exists (they were delivered to); assert on
    // the shape rather than a state, since either is legitimate fixture data.
    for (const entry of ladder) assert.ok(["queued", "delivered", "read", "unknown"].includes(entry.state));
  } finally {
    store.cleanup();
  }
});
