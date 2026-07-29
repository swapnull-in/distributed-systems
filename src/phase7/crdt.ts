/**
 * Phase 7 — CONFLICT RESOLUTION: LWW vs CRDTs. Run: npm run phase7
 *
 * When an AP system takes concurrent writes on both sides of a partition (phase
 * 2), healing means MERGING. Your merge rule decides whether data survives.
 *
 * LWW (last-writer-wins): keep the value with the newest timestamp. Trivially
 * cheap and SILENTLY DISCARDS the concurrent write — it's a data-loss policy
 * wearing a tie-breaker's clothes. And "last" by whose clock? Skewed wall clocks
 * reorder reality. Fine for presence / "last seen" / device settings; indefensible
 * for counters, carts, money.
 *
 * CRDTs (Conflict-free Replicated Data Types): state that MERGES BY MATH, so every
 * replica converges regardless of order — no coordination needed. The bill: every
 * operation must COMMUTE.
 *   • PN-Counter — per-replica increment/decrement tallies; merge = element-wise
 *     max, value = sum. Concurrent increments all count.
 *   • OR-Set — adds tagged with unique ids; merge = union. Concurrent adds all survive.
 *
 * The limit to say out loud: "reserve exactly one of N units" does NOT commute —
 * no CRDT makes it mergeable; that goes to consensus or region-homing.
 *
 * We take a shopping cart, add different items on two partitioned replicas, and
 * merge — LWW loses one item; the OR-Set keeps both. Then a PN-counter converges.
 */

import { log } from "../lib/log.ts";

// ── LWW register: one value + a timestamp; newest wins. ──
interface LWW { value: string[]; ts: number }
function lwwMerge(a: LWW, b: LWW): LWW { return a.ts >= b.ts ? a : b; }

// ── OR-Set: elements tagged with unique add-ids; merge = union of live tags. ──
class ORSet {
  adds = new Map<string, Set<string>>(); // element -> set of unique tags
  add(el: string, tag: string) { (this.adds.get(el) ?? this.adds.set(el, new Set()).get(el)!).add(tag); }
  static merge(a: ORSet, b: ORSet): ORSet {
    const m = new ORSet();
    for (const src of [a, b]) for (const [el, tags] of src.adds) for (const t of tags) m.add(el, t);
    return m;
  }
  values() { return [...this.adds.keys()]; }
}

// ── PN-Counter: per-replica +/- tallies; merge = element-wise max; value = sum. ──
class PNCounter {
  p = new Map<string, number>(); // increments per replica
  inc(replica: string, by = 1) { this.p.set(replica, (this.p.get(replica) ?? 0) + by); }
  static merge(a: PNCounter, b: PNCounter): PNCounter {
    const m = new PNCounter();
    for (const src of [a, b]) for (const [r, v] of src.p) m.p.set(r, Math.max(m.p.get(r) ?? 0, v));
    return m;
  }
  value() { return [...this.p.values()].reduce((s, v) => s + v, 0); }
}

function lwwLosesData() {
  log("═══ A) A cart under LWW — a concurrent add is silently lost ═══");
  // Partition: replica R1 adds "book", replica R2 adds "pen" at (almost) the same time.
  const r1: LWW = { value: ["book"], ts: 1005 }; // R2's clock is slightly ahead
  const r2: LWW = { value: ["pen"], ts: 1006 };
  log(`   R1 cart = [book] @ts1005   R2 cart = [pen] @ts1006  (concurrent, during partition)`);
  const merged = lwwMerge(r1, r2);
  log(`   LWW merge → [${merged.value}]  ❌ "book" is GONE — the customer lost an item`);
  log("");
}

function orSetKeepsBoth() {
  log("═══ B) The same cart as an OR-Set — both adds survive ═══");
  const r1 = new ORSet(); r1.add("book", "r1-a1");
  const r2 = new ORSet(); r2.add("pen", "r2-a1");
  log(`   R1 cart = [book]   R2 cart = [pen]`);
  const merged = ORSet.merge(r1, r2);
  log(`   OR-Set merge → [${merged.values()}]  ✓ union — nothing lost, order-independent`);
  log("");
}

function pnCounterConverges() {
  log("═══ C) A like-counter as a PN-Counter — concurrent increments all count ═══");
  const a = new PNCounter(); const b = new PNCounter(); const c = new PNCounter();
  a.inc("A", 3); b.inc("B", 5); c.inc("C", 2); // three regions increment during partition
  log(`   region A +3, region B +5, region C +2 (each isolated)`);
  // Merge in ANY order — result is the same (that's the point).
  const merged = PNCounter.merge(PNCounter.merge(a, b), c);
  const other = PNCounter.merge(PNCounter.merge(c, a), b);
  log(`   merge(A,B,C) = ${merged.value()} ; merge(C,A,B) = ${other.value()}  ✓ converges to 10 either way`);
  log("");
}

function main() {
  lwwLosesData();
  orSetKeepsBoth();
  pnCounterConverges();
  log("Pick with a trigger:");
  log("   • LWW only where dropping a concurrent write is acceptable AND labeled (presence, last-seen).");
  log("   • CRDTs for collaborative/chat/presence/carts/counters — commutative state.");
  log("   • A global invariant (balance >= 0, 'exactly one of N') does NOT commute → consensus or region-homing.");
  log("   • And 'last' in LWW is a lie under clock skew — see phase 8.");
  process.exit(0);
}

main();
