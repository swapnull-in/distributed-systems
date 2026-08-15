/**
 * Phase 10 — THE DUAL-WRITE PROBLEM, the transactional OUTBOX & idempotency.
 * Run: node "src/phase10/outbox.ts"
 *
 * A service almost never just changes its own DB. It must ALSO tell the world:
 * mark the order paid AND publish "order.placed" so shipping, email, analytics
 * react. The naive code does two writes — one to the DB, one to the broker — as
 * two separate steps. That is the DUAL-WRITE, and it is the canonical
 * distributed-data bug: the two stores are not in one transaction, so any crash
 * between them leaves them disagreeing FOREVER.
 *
 *   • Crash AFTER the DB commit, BEFORE the publish → state changed, no event.
 *     The order is paid but shipping never hears about it. Lost event.
 *   • Publish FIRST, then crash before the DB commit → event with no state.
 *     Shipping ships an order that was never actually paid. Phantom event.
 *
 * You cannot fix this by reordering — one of the two orderings is always wrong.
 * There is no shared transaction across a DB and a broker.
 *
 * TRANSACTIONAL OUTBOX: stop writing to the broker in the request path. In ONE
 * local DB transaction, write the state row AND an event row into an OUTBOX
 * table. They commit together or not at all. A separate RELAY polls the outbox
 * and publishes to the broker AT-LEAST-ONCE, marking rows sent. Crash anywhere
 * and the outbox row survives with the state; on restart the relay replays it.
 * The event and the state can now never disagree — they were one write.
 *
 * IDEMPOTENCY: at-least-once means the relay can publish a DUPLICATE (crash
 * after publish, before marking the row sent → replay publishes it again). The
 * CONSUMER carries an idempotency key per event and dedupes: processing twice
 * has the same effect as once. That is EFFECTIVELY-ONCE built on an at-least-
 * once wire — the only kind of "once" that actually exists.
 *
 * We run the dual-write both ways and watch it break, then the outbox+relay
 * surviving a crash, then a duplicate delivery getting deduped.
 */

import { log } from "../lib/log.ts";

// ── The DB: state rows + an outbox table, with an atomic multi-row txn ────────
interface OrderRow { id: string; status: "created" | "paid" }
interface OutboxRow { key: string; type: string; payload: string; sent: boolean }

class Database {
  orders = new Map<string, OrderRow>();
  outbox = new Map<string, OutboxRow>();

  /** All writes in `fn` apply to a shadow copy; on crash NONE of them land. */
  transaction(fn: (tx: { orders: Map<string, OrderRow>; outbox: Map<string, OutboxRow> }) => void, crash = false): boolean {
    const tx = {
      orders: new Map(this.orders),
      outbox: new Map(this.outbox),
    };
    fn(tx);
    if (crash) return false; // 💥 abort: shadow discarded, real DB untouched
    this.orders = tx.orders;
    this.outbox = tx.outbox;
    return true; // atomic commit of every write in the txn
  }
}

// ── The broker: an append-only log + one consumer with a processed-keys set ───
class Broker {
  log: Array<{ key: string; type: string; payload: string }> = [];
  publish(key: string, type: string, payload: string) {
    this.log.push({ key, type, payload });
    log(`      broker ← published ${type} (key=${key})`);
  }
}

class ShippingConsumer {
  processed = new Set<string>();
  shipped: string[] = [];
  /** Idempotent handler: the key makes a redelivery a no-op. */
  consume(key: string, type: string, payload: string) {
    if (this.processed.has(key)) {
      log(`      consumer: duplicate ${type} (key=${key}) → IGNORED (already processed)`);
      return;
    }
    this.processed.add(key);
    this.shipped.push(payload);
    log(`      consumer: processed ${type} (key=${key}) → scheduled shipment for ${payload}`);
  }
}

// ── A) The dual-write anti-pattern — two stores, no shared txn ─────────────────
function dualWriteLostEvent() {
  log("═══ A1) DUAL-WRITE: DB commit, then crash BEFORE publish → lost event ═══");
  const db = new Database();
  const broker = new Broker();
  db.orders.set("order-1", { id: "order-1", status: "created" });

  // Step 1: change state and commit.
  db.transaction((tx) => tx.orders.set("order-1", { id: "order-1", status: "paid" }));
  log("   DB committed: order-1 = paid");
  // Step 2 would publish — but the process dies right here.
  log("   💥 CRASH before the broker.publish() call ever runs");

  log(`   DB says: order-1 = ${db.orders.get("order-1")!.status}`);
  log(`   broker log length = ${broker.log.length}  ❌ order is PAID but 'order.placed' was never published`);
  log("   → shipping/email/analytics will NEVER hear about it. Permanently inconsistent.");
  log("");
}

function dualWritePhantomEvent() {
  log("═══ A2) DUAL-WRITE reversed: publish, then crash BEFORE DB commit → phantom event ═══");
  const db = new Database();
  const broker = new Broker();
  const consumer = new ShippingConsumer();
  db.orders.set("order-2", { id: "order-2", status: "created" });

  // Step 1: publish first this time.
  broker.publish("evt-2", "order.placed", "order-2");
  // Step 2: commit the DB — but crash aborts the txn.
  db.transaction((tx) => tx.orders.set("order-2", { id: "order-2", status: "paid" }), /* crash */ true);
  log("   💥 CRASH: DB txn aborted, state NOT committed");

  // The consumer already saw the event and acts on it.
  for (const e of broker.log) consumer.consume(e.key, e.type, e.payload);
  log(`   DB says: order-2 = ${db.orders.get("order-2")!.status}  (never paid)`);
  log(`   yet shipping scheduled: [${consumer.shipped.join(", ")}]  ❌ PHANTOM — event for a state that doesn't exist`);
  log("   → neither ordering is safe: one of them always leaves the two stores disagreeing.");
  log("");
}

// ── B) Transactional outbox + relay — one write, replayed at-least-once ────────
function transactionalOutbox() {
  log("═══ B) TRANSACTIONAL OUTBOX: state + event in ONE txn, relay replays after crash ═══");
  const db = new Database();
  const broker = new Broker();
  const consumer = new ShippingConsumer();
  db.orders.set("order-3", { id: "order-3", status: "created" });

  // ONE atomic transaction writes the state change AND the outbox event row.
  db.transaction((tx) => {
    tx.orders.set("order-3", { id: "order-3", status: "paid" });
    tx.outbox.set("evt-3", { key: "evt-3", type: "order.placed", payload: "order-3", sent: false });
  });
  log("   1 txn committed: order-3 = paid  AND  outbox[evt-3] queued (sent=false)");
  log("   💥 CRASH before the relay ever runs — but the event is safe inside the DB");

  // Restart: the relay polls the outbox and publishes anything not yet sent.
  log("   ↻ restart: relay polls the outbox…");
  for (const row of db.outbox.values()) {
    if (row.sent) continue;
    broker.publish(row.key, row.type, row.payload);
    row.sent = true; // mark sent after a successful publish
    log(`      relay marked outbox[${row.key}] sent=true`);
  }
  for (const e of broker.log) consumer.consume(e.key, e.type, e.payload);
  log(`   DB says: order-3 = ${db.orders.get("order-3")!.status}, event delivered=${broker.log.length === 1}`);
  log("   ✓ the state change and the event were the SAME write — they can never disagree.");
  log("");
}

// ── C) Idempotency — at-least-once + dedupe = effectively-once ─────────────────
function idempotentConsumer() {
  log("═══ C) IDEMPOTENCY: relay redelivers a duplicate, consumer dedupes by key ═══");
  const db = new Database();
  const broker = new Broker();
  const consumer = new ShippingConsumer();
  db.orders.set("order-4", { id: "order-4", status: "created" });

  db.transaction((tx) => {
    tx.orders.set("order-4", { id: "order-4", status: "paid" });
    tx.outbox.set("evt-4", { key: "evt-4", type: "order.placed", payload: "order-4", sent: false });
  });

  const row = db.outbox.get("evt-4")!;
  // First relay pass: publish succeeds, but the process crashes BEFORE marking sent.
  broker.publish(row.key, row.type, row.payload);
  log("   💥 CRASH after publish, BEFORE outbox row marked sent → row still sent=false");

  // Restart: relay sees sent=false and publishes AGAIN — the at-least-once duplicate.
  log("   ↻ restart: relay re-polls, row still unsent → publishes AGAIN (at-least-once)");
  broker.publish(row.key, row.type, row.payload);
  row.sent = true;

  // Consumer receives both copies; the idempotency key makes the second a no-op.
  for (const e of broker.log) consumer.consume(e.key, e.type, e.payload);
  log(`   broker delivered ${broker.log.length} copies, but shipments scheduled = ${consumer.shipped.length}`);
  log("   ✓ processed-twice == processed-once → EFFECTIVELY-ONCE on an at-least-once wire.");
  log("");
}

function main() {
  dualWriteLostEvent();
  dualWritePhantomEvent();
  transactionalOutbox();
  idempotentConsumer();
  log("Decisive default + trigger:");
  log("   • 'Never dual-write to a DB and a broker in the request path — I write the event to an");
  log("      OUTBOX in the SAME transaction as the state change, relay it at-least-once, and dedupe");
  log("      by idempotency key. That's how you get effectively-once; there is no exactly-once on the wire.'");
  log("   • Trigger to reach for it: any 'update state AND notify/publish/enqueue' in one handler.");
  log("   • Cheap alternatives: CDC/log-tailing (Debezium) reads the DB's own commit log as the outbox.");
  log("   • Earmark early: 'that's a dual-write; without an outbox the event and the row will drift.'");
  process.exit(0);
}

main();
