/**
 * Phase 5 — DISTRIBUTED TRANSACTIONS: 2PC vs Saga. Run: npm run phase5
 *
 * You need a transaction across multiple services/shards. There is no shared
 * memory and partial failure is normal. Two options:
 *
 * TWO-PHASE COMMIT (2PC): a coordinator asks all participants to PREPARE (lock &
 * promise), then COMMIT. Atomic — but if the COORDINATOR DIES between phases, the
 * participants are stuck IN-DOUBT: locks held, cannot commit, cannot abort, must
 * wait. It couples the availability of every participant to the coordinator and
 * holds locks across the network. That's why it doesn't scale across services.
 *
 * SAGA: a sequence of LOCAL transactions, each with a COMPENSATING action. No
 * global lock, no blocking coordinator. If step 3 fails, you run the
 * compensations for steps 2 and 1 (refund, release) to unwind. You trade
 * atomicity+isolation for availability — and you must design the compensations.
 *
 * We kill the 2PC coordinator mid-protocol (participants hang in-doubt), then run
 * the same business flow as a Saga where a late failure cleanly compensates.
 */

import { log } from "../lib/log.ts";

class Participant {
  state: "idle" | "prepared" | "committed" | "aborted" = "idle";
  locked = false;
  name: string;
  constructor(name: string) { this.name = name; }
  prepare(): boolean { this.state = "prepared"; this.locked = true; log(`      ${this.name}: PREPARED (row locked, awaiting decision)`); return true; }
  commit() { this.state = "committed"; this.locked = false; log(`      ${this.name}: COMMITTED (lock released)`); }
  abort() { this.state = "aborted"; this.locked = false; log(`      ${this.name}: ABORTED (lock released)`); }
}

function twoPhaseCommitCoordinatorDies() {
  log("═══ A) 2PC where the coordinator dies after PREPARE ═══");
  const inventory = new Participant("inventory");
  const payment = new Participant("payment");

  log("   Phase 1 — coordinator sends PREPARE:");
  inventory.prepare();
  payment.prepare();
  log("   Phase 2 — coordinator is about to send COMMIT... 💥 coordinator CRASHES");
  // No decision arrives. Participants cannot unilaterally commit or abort.
  log(`   inventory state = ${inventory.state}, locked=${inventory.locked}`);
  log(`   payment   state = ${payment.state}, locked=${payment.locked}`);
  log("   ❌ both IN-DOUBT: locks held indefinitely, blocking every other txn on those rows.");
  log("   (recovery needs a coordinator log + participant timeouts/heuristics — this is the 2PC tax.)");
  log("");
}

function saga() {
  log("═══ B) The same flow as a Saga (local txns + compensations) ═══");
  const done: Array<{ step: string; compensate: () => void }> = [];
  const run = (step: string, ok: boolean, compensate: () => void): boolean => {
    if (!ok) { log(`      ${step}: FAILED`); return false; }
    log(`      ${step}: done`); done.push({ step, compensate }); return true;
  };

  log("   Forward path:");
  run("reserve inventory", true, () => log("      compensate: release inventory"));
  run("charge payment", true, () => log("      compensate: refund payment"));
  const shipOk = run("dispatch shipment", false, () => log("      compensate: cancel shipment"));

  if (!shipOk) {
    log("   step failed → run compensations in REVERSE (no global lock was ever held):");
    for (const s of [...done].reverse()) s.compensate();
    log("   ✓ system consistent again — every effect was individually undone");
  }
  log("");
}

function main() {
  twoPhaseCommitCoordinatorDies();
  saga();
  log("Decisive default + trigger:");
  log("   • 'Saga by default — services are independent failure domains; I won't couple");
  log("      their availability behind a blocking coordinator holding cross-network locks.'");
  log("   • Trigger to flip: single tightly-coupled stack, low scale, TRUE atomicity required → XA/2PC ok.");
  log("   • Earmark early: 'that's a distributed transaction; the hard parts are compensations and isolation.'");
  log("   • And never claim exactly-once on the wire: at-least-once + idempotent = effectively-once.");
  process.exit(0);
}

main();
