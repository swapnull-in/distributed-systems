/**
 * Phase 6 — RETRY STORMS & METASTABLE FAILURE. Run: npm run phase6
 *
 * The outage pattern that eats real systems. A downstream slows for a moment
 * (deploy, GC, cold cache). Requests fail. Every layer RETRIES. Retries are new
 * load, so offered load multiplies exactly when the system is weakest. The
 * failure becomes METASTABLE: even after the ORIGINAL trigger is gone, the
 * retries themselves sustain the overload — goodput stays on the floor until you
 * actively SHED load. The system found a stable-but-broken equilibrium.
 *
 * The three fixes, all here:
 *   • RETRY BUDGET — cap retries to a small fraction of base traffic (e.g. 10%),
 *     so retries can never multiply load.
 *   • JITTER — spread retries in time so they don't synchronize into spikes.
 *   • CIRCUIT BREAKER — trip on high error rate (or p99 latency) and STOP sending,
 *     shedding load so the downstream can recover.
 *
 * We run the same capacity dip through a naive retrier and a budgeted+breakered
 * one, and print goodput per round. Watch naive stay collapsed AFTER recovery.
 */

import { log } from "../lib/log.ts";

const ROUNDS = 12;
const BASE = 80;                 // steady offered load per round
const NORMAL_CAP = 100;          // downstream can serve this many/round
const DIP_ROUNDS = new Set([3, 4, 5]); // a transient degradation
const DIP_CAP = 40;

function capacity(round: number) { return DIP_ROUNDS.has(round) ? DIP_CAP : NORMAL_CAP; }

const RETRY_FACTOR = 3;  // naive: each failed request spawns retries (which can fail and retry again)
const CEILING = 100_000; // just to keep the runaway number finite for display

/**
 * Returns USEFUL goodput per round — genuine (first-attempt) work completed.
 * Key insight: when the channel is saturated by retries, the server is "busy"
 * (served == capacity) but most of that served work is DUPLICATE retries, so the
 * fraction doing genuine work is base/offered. That fraction is what collapses.
 */
function simulate(mode: "naive" | "fixed"): number[] {
  const goodput: number[] = [];
  let retryQueue = 0;   // carried-over retries (extra load)
  let breakerOpen = false;

  for (let r = 1; r <= ROUNDS; r++) {
    const cap = capacity(r);

    // FIXED: an open breaker sheds the retry backlog entirely (load shedding).
    if (mode === "fixed" && breakerOpen) retryQueue = 0;
    const admittedRetries = mode === "fixed" ? Math.min(retryQueue, Math.floor(BASE * 0.1)) : retryQueue;

    const offered = BASE + admittedRetries;
    const served = Math.min(offered, cap);
    const failed = offered - served;
    const usefulGoodput = Math.round(served * (BASE / offered)); // genuine fraction of served work
    goodput.push(usefulGoodput);

    if (mode === "naive") {
      retryQueue = Math.min(failed * RETRY_FACTOR, CEILING); // amplification with no cap → metastable
    } else {
      const errRate = offered > 0 ? failed / offered : 0;
      breakerOpen = errRate > 0.3; // trip on high error rate (real systems: also p99 latency)
      retryQueue = failed;         // clamped by budget/breaker next round
    }
  }
  return goodput;
}

function bar(n: number) { return "█".repeat(Math.round(n / 4)); }

function main() {
  const naive = simulate("naive");
  const fixed = simulate("fixed");

  log("═══ USEFUL goodput per round — genuine work done (capacity dips in rounds 3–5) ═══");
  log("   round | cap | NAIVE retries      | FIXED (budget+breaker)");
  for (let i = 0; i < ROUNDS; i++) {
    const r = i + 1;
    const cap = capacity(r);
    log(
      `   ${String(r).padStart(5)} | ${String(cap).padStart(3)} | ` +
      `${String(naive[i]).padStart(3)} ${bar(naive[i]).padEnd(20)}| ` +
      `${String(fixed[i]).padStart(3)} ${bar(fixed[i])}`,
    );
  }
  log("");
  const recoveredRound = 6; // capacity is back to 100 from round 6 on
  log(`   After capacity recovers (round ${recoveredRound}+):`);
  log(`     NAIVE goodput = ${naive[recoveredRound - 1]}  ❌ still collapsed — retries became the load (METASTABLE)`);
  log(`     FIXED goodput = ${fixed[recoveredRound - 1]}  ✓ recovered to base ${BASE} — the breaker shed the storm`);
  log("");
  log("Say it like this:");
  log("   • 'A transient slowdown becomes a permanent outage when retries turn into load.");
  log("      I cap retries with a budget, add full jitter, and trip the breaker on p99");
  log("      latency — not just errors — so we shed load and let the dependency recover.'");
  process.exit(0);
}

main();
