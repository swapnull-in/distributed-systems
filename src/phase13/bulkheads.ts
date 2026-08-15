/**
 * Phase 13 — BULKHEADS & SHUFFLE SHARDING: capping the BLAST RADIUS.
 * Run: node "src/phase13/bulkheads.ts"
 *
 * Phase 6 (breakers, budgets, limiters) caps how much load a dependency can take
 * over TIME. This is the other axis: capping how many TENANTS one bad actor can
 * take down at ONCE. A single tenant sends "poison" requests — a hot loop, a
 * pathological query, a retry storm of their own — that tie up every worker they
 * touch. The question is not "will it hurt?" but "how many neighbours drown with
 * them?" That number is the BLAST RADIUS, and you get to design it.
 *
 * Three ways to run one worker pool for many tenants:
 *   A) SHARED POOL (no isolation) — everyone shares all N workers. Cheap and
 *      efficient (perfect statistical multiplexing) right up until one poison
 *      tenant saturates the pool and takes down 100% of tenants with it.
 *   B) BULKHEADS (dedicated pools) — like a ship's watertight compartments: give
 *      each tenant its own small pool. A flood in one compartment can't sink the
 *      others. Blast radius = 1 tenant. The price is rigid capacity: you must
 *      pre-provision a whole pool per tenant, and you lose all multiplexing —
 *      idle pools sit idle while busy pools reject work.
 *   C) SHUFFLE SHARDING — the middle path. Hand each tenant a RANDOM subset (a
 *      shard) of k workers out of N. Two tenants only fully collide when one
 *      tenant's entire k-set lands inside the poison tenant's k-set — which,
 *      combinatorially, almost never happens. You keep the multiplexing of a
 *      shared pool but shrink the blast radius to a tiny fraction, WITHOUT
 *      dedicating a full pool to anyone. This is the AWS technique behind
 *      Route 53 and cell-based architectures.
 *
 * We run n=16 workers, k=2 per tenant, ~100 tenants, exactly ONE poison tenant,
 * and print the fraction of tenants degraded under each design. Deterministic:
 * shards come from a seeded PRNG (mulberry32), so the numbers reproduce.
 *
 * Money quote: bulkheads cap the blast radius so one poisoned tenant can't sink
 * everyone; shuffle sharding makes any two tenants' worker sets overlap
 * combinatorially rarely, so a poison-pill harms a tiny fraction instead of
 * 100% — isolation without dedicating a full pool per tenant.
 */

import { log } from "../lib/log.ts";

const N_WORKERS = 16;   // total workers in the shared fleet
const K = 2;            // workers per tenant shard (shuffle sharding)
const TENANTS = 100;    // tenant 0 is the POISON tenant; 1..99 are innocent
const SEED = 0x5eed1234; // fixed seed → deterministic shard assignment

/** mulberry32 — tiny deterministic PRNG so shard assignment is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick k DISTINCT workers out of n via a partial Fisher–Yates shuffle. */
function pickShard(rng: () => number, n: number, k: number): number[] {
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, k).sort((x, y) => x - y);
}

/** n choose r — for the theoretical overlap probability. */
function choose(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  let c = 1;
  for (let i = 0; i < r; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function bar(fraction: number): string {
  return "█".repeat(Math.round(fraction * 40));
}

/**
 * A) SHARED POOL — the poison tenant's flood fills every slot in the one pool,
 * so every other tenant finds the fleet saturated. Blast radius = all tenants.
 */
function sharedPool(): number {
  // Poison saturates the shared pool → every tenant (including itself) degraded.
  const degraded = TENANTS;
  return degraded / TENANTS;
}

/**
 * B) BULKHEADS — each tenant owns a dedicated pool, walled off from the rest.
 * The poison flood exhausts only its OWN pool; no other pool can even see it.
 * Blast radius = 1 tenant. Cost: N_WORKERS×TENANTS capacity to pre-provision,
 * and zero statistical multiplexing (idle pools can't lend to busy ones).
 */
function bulkheads(): number {
  const degraded = 1; // only the poison tenant's own compartment floods
  return degraded / TENANTS;
}

/**
 * C) SHUFFLE SHARDING — each tenant gets a random k-of-N shard. The poison tenant
 * saturates its k workers. A victim is FULLY degraded only if EVERY worker in its
 * shard is one the poison tenant also holds (all its workers are underwater); if
 * it shares only some, it still has a healthy worker to fall back on. We measure
 * that fraction directly, then compare to theory.
 */
function shuffleSharding(): { affected: number; partial: number; theory: number } {
  const rng = mulberry32(SEED);
  const shards: number[][] = [];
  for (let t = 0; t < TENANTS; t++) shards.push(pickShard(rng, N_WORKERS, K));

  const poison = new Set(shards[0]); // the poison tenant's saturated workers

  let fullyDegraded = 0; // every worker in the shard is poisoned → no healthy fallback
  let partialHit = 0;    // shares some but not all workers → degraded-but-survives
  for (let t = 1; t < TENANTS; t++) {
    const overlap = shards[t].filter((w) => poison.has(w)).length;
    if (overlap === shards[t].length) fullyDegraded++;
    else if (overlap > 0) partialHit++;
  }

  // Theoretical P(a victim's entire k-shard lands inside the poison's k workers)
  // = C(k, k) / C(N, k)  = 1 / C(N, k).
  const theory = choose(K, K) / choose(N_WORKERS, K);

  // Report affected fraction over ALL tenants (poison tenant counts as affected too).
  const affected = (fullyDegraded + 1) / TENANTS;
  log(`   shuffle: ${fullyDegraded}/${TENANTS - 1} victims fully underwater, ` +
      `${partialHit} partially hit (kept a healthy worker) — poison shard = {${shards[0].join(",")}}`);
  return { affected, partial: partialHit, theory };
}

function main() {
  log("═══ Setup: one worker fleet, one poison tenant, three isolation designs ═══");
  log(`   N=${N_WORKERS} workers, k=${K} workers/shard, ${TENANTS} tenants (tenant#0 = POISON).`);
  log(`   Poison tenant floods whatever workers it can reach and never lets go.`);
  log("");

  const a = sharedPool();
  const b = bulkheads();
  const c = shuffleSharding();

  log("");
  log("═══ Blast radius — fraction of tenants degraded by the ONE poison tenant ═══");
  log(`   A) SHARED POOL      ${pct(a).padStart(7)} ${bar(a)}`);
  log(`   B) BULKHEADS        ${pct(b).padStart(7)} ${bar(b)}  (dedicated pool per tenant)`);
  log(`   C) SHUFFLE SHARDING ${pct(c.affected).padStart(7)} ${bar(c.affected)}  (k=${K} of N=${N_WORKERS} random shard)`);
  log("");
  log(`   Shuffle-sharding theory: P(victim's whole shard ⊆ poison's shard) = 1 / C(${N_WORKERS},${K})`);
  log(`     = 1 / ${choose(N_WORKERS, K)} = ${pct(c.theory)}  (measured full hits track this)`);
  log("");

  log("Takeaways:");
  log("   • SHARED POOL: perfect multiplexing, blast radius 100% — one poison tenant sinks all.");
  log("   • BULKHEADS: static isolation, blast radius 1 tenant — but rigid, N×tenants capacity,");
  log("     no multiplexing (idle pools can't cover busy ones).");
  log("   • SHUFFLE SHARDING: probabilistic isolation — keeps multiplexing, shrinks blast radius");
  log("     combinatorially (1/C(N,k)) WITHOUT a full pool per tenant. This is Route 53 / cells.");
  log("   • Phase 6 caps load over TIME (breaker/budget/limiter); bulkheads & shuffle sharding");
  log("     cap blast radius across TENANTS. Real systems need BOTH axes.");
  log("");
  log("Say it like this:");
  log("   • 'Bulkheads cap the blast radius so one poisoned tenant can't sink everyone; shuffle");
  log("      sharding makes any two tenants' worker sets overlap combinatorially rarely, so a");
  log("      poison-pill harms a tiny fraction instead of 100% — isolation without dedicating a");
  log("      full pool per tenant.'");
  log("");
  log("Decisive default + trigger:");
  log("   • Default: shared pool with per-tenant limiters. Trigger a move to SHUFFLE SHARDING the");
  log("     moment one tenant's bad day can degrade unrelated tenants (noisy-neighbour, multi-tenant");
  log("     control plane). Reach for full BULKHEADS only when a tenant needs a hard, audited");
  log("     capacity guarantee and you can afford to pre-provision it.");
  process.exit(0);
}

main();
