/**
 * Phase 11 — HYBRID LOGICAL CLOCK (HLC). Run: node "src/phase11/hlc.ts"
 *
 * Phase 8 left one clock NAMED but not BUILT: HLC — the pragmatic default. Recall
 * the three it did build, and what each gets wrong:
 *   • WALL-CLOCK — cheap, human-readable, but skew INVERTS causality: a reply can
 *     carry a LOWER timestamp than the message it answers, so LWW keeps the wrong
 *     write. (Phase 8, part A.)
 *   • LAMPORT — a single counter that restores causal order (a → b ⇒ L(a) < L(b)),
 *     but its magnitude is MEANINGLESS: "42" tells you nothing about when in real
 *     time it happened, so you can't range-scan by time or expire a lease with it.
 *   • VECTOR — detects concurrency, but grows O(nodes) — not constant size.
 *
 * HLC is Lamport's logic WRAPPED AROUND physical time. A timestamp is a pair:
 *   (pt, l)   pt = a physical-time component that tracks the wall clock
 *             l  = a small logical counter that breaks ties WITHIN one pt
 * Compare lexicographically by (pt, l). The update rules keep pt = max(everything
 * seen so far, own wall clock), and bump l only when pt can't advance:
 *
 *   local / send : ptNew = max(pt, wall)
 *                  l = (ptNew == pt) ? l+1 : 0
 *   receive(msg) : ptNew = max(pt, msg.pt, wall)
 *                  ptNew==pt && ptNew==msg.pt : l = max(l, msg.l) + 1
 *                  ptNew==pt                  : l = l + 1
 *                  ptNew==msg.pt              : l = msg.l + 1
 *                  else                       : l = 0
 *
 * The payoff: causal order like Lamport (send < receive, ALWAYS), a pt that stays
 * within a bounded distance of real wall time (unlike Lamport's opaque integer),
 * and constant size (unlike vector's per-node array) — with no atomic clocks.
 *
 * We reuse Phase 8's skew: node B's wall clock runs BEHIND node A's. Wall-clock
 * LWW picks the wrong winner; HLC forces B's reply strictly above A's send.
 */

import { log } from "../lib/log.ts";

interface Stamp { pt: number; l: number }

/** One node's HLC. Wall-clock readings are passed IN so the demo is deterministic. */
class HLC {
  private pt = 0;
  private l = 0;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  now(): Stamp {
    return { pt: this.pt, l: this.l };
  }

  /** A local event or an outbound send: advance against this node's wall clock. */
  local(wall: number): Stamp {
    const ptNew = Math.max(this.pt, wall);
    this.l = ptNew === this.pt ? this.l + 1 : 0;
    this.pt = ptNew;
    return this.now();
  }

  /** Receiving a message carrying the sender's HLC stamp, with our own wall reading. */
  receive(msg: Stamp, wall: number): Stamp {
    const ptNew = Math.max(this.pt, msg.pt, wall);
    if (ptNew === this.pt && ptNew === msg.pt) this.l = Math.max(this.l, msg.l) + 1;
    else if (ptNew === this.pt) this.l = this.l + 1;
    else if (ptNew === msg.pt) this.l = msg.l + 1;
    else this.l = 0;
    this.pt = ptNew;
    return this.now();
  }
}

/** Lexicographic compare on (pt, l): -1 if a<b, 1 if a>b, 0 if equal. */
function cmp(a: Stamp, b: Stamp): number {
  if (a.pt !== b.pt) return a.pt < b.pt ? -1 : 1;
  if (a.l !== b.l) return a.l < b.l ? -1 : 1;
  return 0;
}

const show = (s: Stamp) => `(pt=${s.pt}, l=${s.l})`;

function skewCannotInvertCausality() {
  log("═══ A) Skewed clocks, but HLC preserves send < receive ═══");
  // Same setup as Phase 8: A's clock runs ahead, B's is 15ms behind.
  const A = new HLC("A");
  const B = new HLC("B");

  const sendWall = 1000; // A's wall clock when it sends
  const recvWall = 985;  // B's wall clock is BEHIND — even though receive happens AFTER send

  const sent = A.local(sendWall);          // A: local event + send at wall=1000
  log(`   A sends at wall=${sendWall} → HLC ${show(sent)}`);

  // Naive wall-clock LWW would compare 1000 vs 985 and keep the SEND — wrong winner.
  const lwwWinner = sendWall >= recvWall ? "A's send" : "B's reply";
  log(`   wall-clock LWW compares ${sendWall} vs ${recvWall} → keeps "${lwwWinner}"  ❌ reply is newer, causality inverted`);

  const recvd = B.receive(sent, recvWall); // B: receives, HLC forced ≥ sender's
  log(`   B receives at wall=${recvWall} → HLC ${show(recvd)}  (pt pulled up to A's ${sent.pt}, not B's ${recvWall})`);

  const order = cmp(sent, recvd);
  log(`   compare HLC ${show(sent)} vs ${show(recvd)} → send ${order < 0 ? "<" : order > 0 ? ">" : "="} receive`);
  log(`   ${order < 0 ? "✓ causal order HELD — the lower wall clock could not invert it" : "✗ broken"}`);
  log("");
}

function staysCloseToWallAndCounterStaysSmall() {
  log("═══ B) pt tracks real time; l stays small (constant size) ═══");
  const N = new HLC("N");

  // Three events at the SAME physical instant: pt can't advance, so l breaks ties.
  const t = 2000;
  const e1 = N.local(t);
  const e2 = N.local(t);
  const e3 = N.local(t);
  log(`   3 events all at wall=${t}: ${show(e1)} → ${show(e2)} → ${show(e3)}`);
  log(`   pt frozen at ${t} (== wall, human-readable — Lamport's bare integer tells you nothing about time)`);
  log(`   l ticks 0→1→2 ONLY to order events inside one instant`);

  // Wall clock advances → pt follows it and l RESETS. Counter never grows unbounded.
  const later = N.local(2003);
  log(`   next event at wall=2003 → ${show(later)}: pt jumps to 2003, l RESETS to 0`);
  log(`   |pt − wall| stayed 0 here and is bounded by clock skew in general → constant size, near-real time  ✓`);
  log("");
}

function main() {
  skewCannotInvertCausality();
  staysCloseToWallAndCounterStaysSmall();
  log("Say it like this:");
  log("   • 'HLC is my default: Lamport's a→b ⇒ ts(a)<ts(b) causal guarantee, but on timestamps");
  log("      that stay within bounded distance of wall-clock time — in CONSTANT size, no atomic clocks.'");
  log("   • 'pt tracks physical time so I can range-scan and expire leases; l is a tiny tie-breaker");
  log("      that only grows within one physical instant, then resets — it never blows up.'");
  log("   • 'Skew can't invert causality: receive forces pt ≥ the sender's, so send < receive always holds.'");
  log("   • 'TrueTime chases the SAME goal by buying atomic clocks + commit-wait; HLC gets most of it for free.'");
  process.exit(0);
}

main();
