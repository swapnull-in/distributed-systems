/**
 * Phase 1 — CONSISTENCY & WRITE SKEW. Run: npm run phase1
 *
 * The single most-probed anomaly in a distributed/DB interview, because it is
 * INVISIBLE at the isolation level most people think is safe.
 *
 * Snapshot Isolation (SI) — what Postgres calls REPEATABLE READ — gives every
 * transaction a stable snapshot: it reads the database as-of when it began, and
 * two txns writing DIFFERENT rows never conflict. That last part is the trap.
 *
 * WRITE SKEW: two transactions read an overlapping set, each decides its write
 * is fine based on that read, and each writes a *different* row. No write-write
 * conflict exists, so SI lets BOTH commit — and together they break an invariant
 * that spans the rows ("at least one doctor on call", "no double-booking",
 * "balance >= 0 across accounts").
 *
 * THE FIX: make the conflict materialize. Either SERIALIZABLE (SSI detects the
 * read-write dependency cycle and aborts one) or SELECT ... FOR UPDATE (lock the
 * rows both txns depend on, so the second blocks and re-reads).
 *
 * We reproduce the classic on-call-doctors bug, then show the serialize fix.
 */

import { log } from "../lib/log.ts";

interface Row { onCall: boolean }

class SnapshotDB {
  private rows = new Map<string, Row>();
  private lockedBy = new Map<string, number>(); // for the FOR UPDATE fix

  constructor(seed: Record<string, boolean>) {
    for (const [k, v] of Object.entries(seed)) this.rows.set(k, { onCall: v });
  }

  /** A stable read against the snapshot the txn began with (SI: value at begin). */
  countOnCall(snapshot: Map<string, Row>): number {
    let n = 0;
    for (const r of snapshot.values()) if (r.onCall) n++;
    return n;
  }

  /** Take a snapshot copy — SI hands each txn its own immutable view. */
  snapshot(): Map<string, Row> {
    const s = new Map<string, Row>();
    for (const [k, v] of this.rows) s.set(k, { ...v });
    return s;
  }

  /** Pessimistic lock for the SERIALIZABLE / FOR UPDATE path. */
  lock(key: string, txn: number): boolean {
    const holder = this.lockedBy.get(key);
    if (holder !== undefined && holder !== txn) return false; // would block
    this.lockedBy.set(key, txn);
    return true;
  }

  write(key: string, onCall: boolean) { this.rows.set(key, { onCall }); }
  live() { return this.countOnCall(this.rows); }
  reset(seed: Record<string, boolean>) {
    this.rows.clear(); this.lockedBy.clear();
    for (const [k, v] of Object.entries(seed)) this.rows.set(k, { onCall: v });
  }
}

function brokenUnderSI() {
  log("═══ A) Write skew under Snapshot Isolation (the bug) ═══");
  const db = new SnapshotDB({ alice: true, bob: true });
  log("   Invariant: at least 1 doctor on call. Both start on call.");

  // Both txns begin and take their snapshot BEFORE either writes.
  const t1 = db.snapshot();
  const t2 = db.snapshot();

  log(`   T1 (Alice) reads count on call = ${db.countOnCall(t1)} → 2, safe to go off`);
  log(`   T2 (Bob)   reads count on call = ${db.countOnCall(t2)} → 2, safe to go off  [same snapshot]`);

  db.write("alice", false); // T1 commits — different row than T2
  db.write("bob", false);   // T2 commits — no write-write conflict to detect

  log(`   both commit → doctors on call = ${db.live()}  ❌ INVARIANT VIOLATED (SI never saw a conflict)`);
  log("");
}

function fixedBySerialize() {
  log("═══ B) The fix: materialize the conflict (SERIALIZABLE / FOR UPDATE) ═══");
  const db = new SnapshotDB({ alice: true, bob: true });

  // Both txns must LOCK the rows the invariant depends on before deciding.
  // T1 grabs the locks first; T2 blocks, and on re-read sees only 1 left.
  const t1GotLocks = db.lock("alice", 1) && db.lock("bob", 1);
  log(`   T1 takes FOR UPDATE locks on {alice,bob}: ${t1GotLocks ? "acquired" : "blocked"}`);

  const t2Blocked = !db.lock("alice", 2); // contends on the same rows
  log(`   T2 tries the same locks → ${t2Blocked ? "BLOCKS until T1 commits" : "acquired"}`);

  if (db.countOnCall(db.snapshot()) >= 2) db.write("alice", false); // T1: 2 on call, ok
  log(`   T1 sets Alice off-call and commits → on call = ${db.live()}`);

  // T2 unblocks, RE-READS fresh state, now sees only 1 on call → refuses.
  const fresh = db.live();
  log(`   T2 unblocks, re-reads count on call = ${fresh}`);
  if (fresh <= 1) log(`   T2 REFUSES to go off-call → on call stays ${db.live()}  ✓ invariant held`);
  log("");
}

function main() {
  brokenUnderSI();
  fixedBySerialize();
  log("Takeaways:");
  log("   • SI / Postgres REPEATABLE READ ALLOWS write skew — different rows, no conflict.");
  log("   • Any 'exactly one of N' or 'no overlap' invariant is a write-skew risk — earmark it EARLY.");
  log("   • Fix: SERIALIZABLE (SSI aborts one, watch for 40001 retries) or SELECT ... FOR UPDATE.");
  process.exit(0);
}

main();
