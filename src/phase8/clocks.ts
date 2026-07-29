/**
 * Phase 8 — CLOCKS: physical, logical, vector. Run: npm run phase8
 *
 * "Order these two events" is the quiet killer. Wall clocks on different machines
 * drift and get NTP-stepped; a lower timestamp does NOT mean "happened first."
 * Using NOW() for ordering / LWW / lease expiry silently corrupts state.
 *
 *   • LAMPORT clock — a single counter: increment on each event, and on receive
 *     set counter = max(local, incoming) + 1. Gives a total order CONSISTENT with
 *     causality (if a → b then L(a) < L(b)). But L(a) < L(b) does NOT prove
 *     causality — it can't tell "before" from "concurrent."
 *   • VECTOR clock — one counter per node. It can DETECT concurrency: a → b iff
 *     V(a) <= V(b) elementwise and they differ; neither <= the other ⇒ CONCURRENT
 *     (a real conflict to resolve, not a false winner to pick).
 *   • HLC (hybrid logical clock) — Lamport logic wrapped around wall time: causal
 *     ordering + near-real timestamps, constant size, no special hardware. The
 *     sensible default. (TrueTime is the same idea with atomic clocks + wait.)
 *
 * We show wall-clock skew INVERTING a cause→effect pair (LWW picks the wrong
 * winner), Lamport restoring the order, and vector clocks flagging concurrency.
 */

import { log } from "../lib/log.ts";

function wallClockInverts() {
  log("═══ A) Wall-clock skew inverts causality (LWW picks the wrong winner) ═══");
  // A writes x, then MESSAGES B, which writes y as a reply. True order: x → y.
  // But A's clock is skewed +30ms ahead of B's.
  const xWall = 1000; // A's clock
  const yWall = 985;  // B's clock (skewed behind), even though y happened AFTER x
  log(`   true causal order: x (A writes) → y (B replies)`);
  log(`   wall timestamps:   x@${xWall}ms   y@${yWall}ms   (A's clock runs ahead)`);
  const lwwWinner = xWall >= yWall ? "x" : "y";
  log(`   LWW keeps the higher timestamp → "${lwwWinner}"  ❌ keeps x, discards the newer y — causality inverted`);
  log("");
}

function lamportRestores() {
  log("═══ B) Lamport clock restores the causal order ═══");
  let aClock = 0, bClock = 0;
  aClock++;                       // event x on A
  const xL = aClock;
  const msgStamp = aClock;        // A sends message carrying its clock
  bClock = Math.max(bClock, msgStamp) + 1; // B receives, then event y
  const yL = bClock;
  log(`   x on A → Lamport ${xL};  message carries ${msgStamp};  y on B → max(0,${msgStamp})+1 = ${yL}`);
  log(`   ${xL} < ${yL} → x before y  ✓ causal order preserved regardless of wall clocks`);
  log("");
}

function vectorDetectsConcurrency() {
  log("═══ C) Vector clocks DETECT concurrency (what Lamport can't) ═══");
  const cmp = (a: number[], b: number[]) => {
    const le = a.every((v, i) => v <= b[i]);
    const ge = a.every((v, i) => v >= b[i]);
    if (le && !ge) return "a → b (a happened-before b)";
    if (ge && !le) return "b → a (b happened-before a)";
    if (le && ge) return "equal";
    return "CONCURRENT (independent — a real conflict)";
  };
  // Nodes [A,B]. Causal pair:
  const x = [1, 0]; // A's write
  const y = [1, 1]; // B saw x then wrote → dominates x
  log(`   x=V${JSON.stringify(x)}  y=V${JSON.stringify(y)} → ${cmp(x, y)}`);
  // Concurrent pair: each acted without seeing the other.
  const p = [2, 0];
  const q = [0, 2];
  log(`   p=V${JSON.stringify(p)}  q=V${JSON.stringify(q)} → ${cmp(p, q)}  ✓ flagged, not silently merged`);
  log("");
}

function main() {
  wallClockInverts();
  lamportRestores();
  vectorDetectsConcurrency();
  log("Say it like this:");
  log("   • 'I never use wall-clock NOW() for ordering — skew and NTP steps corrupt it.'");
  log("   • 'HLC by default: causality plus near-real timestamps, constant size, no special hardware.'");
  log("   • 'Vector clocks when I need to DETECT concurrent writes and merge them by business rule,");
  log("      rather than let LWW silently pick a wrong winner.'");
  log("   • 'TrueTime buys external consistency by owning atomic clocks and WAITING out the uncertainty.'");
  process.exit(0);
}

main();
