/**
 * The delivery ladder, derived from the receipt *and its witness*.
 *
 * This module exists because of one sentence in the brief, which is the easiest
 * thing in the whole client to get wrong:
 *
 * > **Never read an absent `deliveredAt` as "not delivered."** §5.3: when the
 * > receipt and the `read/` copy disagree, **the copy is the witness** — stamped
 * > earlier, written before `markDelivered`, so it is the record the receipt can
 * > lose.
 *
 * `src/store.ts` makes three separate writes when a message is delivered: the
 * envelope is renamed into `inbox/<name>/read/`, a stamped copy is written
 * beside it, and only then is `markDelivered` called. A crash between the second
 * and third leaves a `read/` copy whose `deliveredAt` is real and a receipt that
 * has never heard of it. A client that trusts only the receipt decides that mail
 * already in the recipient's hands was lost, and re-sends it.
 *
 * So the ladder here is **four** states, not two:
 *
 * | state       | evidence                                                  |
 * |-------------|-----------------------------------------------------------|
 * | `read`      | a `readAt` — only ever written by `ack`, a human's act     |
 * | `delivered` | a `deliveredAt`, from the receipt **or** the read/ copy    |
 * | `queued`    | a `queuedAt` and nothing about delivery: delivery unknown  |
 * | `unknown`   | no receipt file and no read/ copy at all                   |
 *
 * `queued` is not a failure and is never rendered as one. It is the honest
 * statement "the envelope exists; whether the session has taken it is not
 * recorded here", which is what §5.3 asks for. {@link describeDelivery} carries
 * the wording so no caller has to invent it.
 */

import * as path from "node:path";

import { readTextFile } from "./readonly-fs.ts";

export type DeliveryState = "unknown" | "queued" | "delivered" | "read";

/** Where a `deliveredAt` came from, so the report can prove the witness rule ran. */
export type DeliveryWitness = "receipt" | "read-copy" | "none";

export interface RecipientDelivery {
  recipient: string;
  state: DeliveryState;
  queuedAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  /** `receipt` when the receipt carried `deliveredAt`; `read-copy` when only the copy did. */
  witness: DeliveryWitness;
}

interface ReceiptEntry {
  queuedAt?: string;
  deliveredAt?: string;
  readAt?: string;
}

interface ReceiptRecord {
  id: string;
  receipts: Record<string, ReceiptEntry>;
}

function readJson<T>(file: string): T | null {
  const raw = readTextFile(file);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed != null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function iso(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reduce one recipient's evidence to a state.
 *
 * Exported because it is the whole rule and a test should be able to assert on
 * it without building a store. Note what is *not* here: there is no branch that
 * produces "not delivered". The weakest answer available is `unknown`.
 */
export function stateOf(entry: {
  queuedAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}): DeliveryState {
  if (entry.readAt != null) return "read";
  if (entry.deliveredAt != null) return "delivered";
  if (entry.queuedAt != null) return "queued";
  return "unknown";
}

/** The sentence the UI shows. One place, so the honest wording cannot drift. */
export function describeDelivery(delivery: RecipientDelivery): string {
  switch (delivery.state) {
    case "read":
      return "read — a client rendered it and the reader acknowledged";
    case "delivered":
      return delivery.witness === "read-copy"
        ? "delivered — the inbox copy is the witness; the receipt had lost the stamp"
        : "delivered — the recipient's session was handed it";
    case "queued":
      return "queued — the envelope exists; delivery is not recorded, which is not the same as not delivered";
    case "unknown":
      return "unknown — no receipt and no inbox copy; nothing was claimed either way";
  }
}

export interface ReceiptPaths {
  receipts: string;
  inbox: string;
}

/**
 * One message's per-recipient ladder.
 *
 * `witness` defaults to true and reads `inbox/<recipient>/read/<id>.json`. That
 * read is only ever done for **room** posts, whose bodies are already public in
 * `rooms/<room>/log.jsonl` — so consulting the copy leaks nothing that the room
 * log does not already contain. Callers rendering a DM pass `witness: false` and
 * get the receipt alone, because a DM's body is not public and the client has no
 * business reading another name's inbox to render one.
 */
export function receiptLadder(
  paths: ReceiptPaths,
  id: string,
  recipients: readonly string[],
  options: { witness?: boolean } = {},
): RecipientDelivery[] {
  const useWitness = options.witness ?? true;
  // The same shape `readReceipts` validates before the id becomes a path
  // segment. A log line is store data, not trusted input: an id of
  // `../../etc/passwd` must not escape the receipts directory.
  const safeId = /^[0-9a-f-]{8,}$/i.test(id) ? id : null;
  const record = safeId == null ? null : readJson<ReceiptRecord>(path.join(paths.receipts, `${safeId}.json`));

  return recipients.map((recipient) => {
    const entry = record?.receipts?.[recipient] ?? null;
    // `read/` copy: the witness the receipt can lose.
    const copy =
      useWitness && safeId != null && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(recipient)
        ? readJson<ReceiptEntry>(path.join(paths.inbox, recipient, "read", `${safeId}.json`))
        : null;

    const fromReceipt = iso(entry?.deliveredAt);
    const fromCopy = iso(copy?.deliveredAt);
    const deliveredAt = fromReceipt ?? fromCopy ?? null;
    const witness: DeliveryWitness =
      fromReceipt != null ? "receipt" : fromCopy != null ? "read-copy" : "none";

    const result = {
      recipient,
      queuedAt: iso(entry?.queuedAt) ?? iso(copy?.queuedAt) ?? null,
      deliveredAt,
      readAt: iso(entry?.readAt) ?? iso(copy?.readAt) ?? null,
      witness,
    };
    return { ...result, state: stateOf(result) };
  });
}

/**
 * The ladder for a whole batch of ids, keyed by id.
 *
 * Batched so the SSE handler can refresh a window of new posts in one call
 * rather than one synchronous file read per row on the event loop.
 */
export function receiptLadderBatch(
  paths: ReceiptPaths,
  messages: ReadonlyArray<{ id?: string; recipients?: readonly string[] }>,
  options: { witness?: boolean } = {},
): Record<string, RecipientDelivery[]> {
  const out: Record<string, RecipientDelivery[]> = {};
  for (const message of messages) {
    if (typeof message.id !== "string" || message.id.length === 0) continue;
    out[message.id] = receiptLadder(paths, message.id, message.recipients ?? [], options);
  }
  return out;
}
