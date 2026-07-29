/**
 * CAPSTONE — MULTI-REGION & STATIC STABILITY: the fiber-cut drill. Run: npm run capstone
 *
 * The L6 multi-region round in code. A system is STATICALLY STABLE when it keeps
 * working through a region loss WITHOUT any control-plane action — no scaling
 * decision, no config push, no leader election on the critical path, no human.
 * The failover consumes only decisions made, and capacity provisioned, BEFORE the
 * failure. This simulator proves the three commitments:
 *
 *   1. PRE-PROVISIONED survivor capacity — 3 regions each run at ≤66%, so any one
 *      region's death is absorbed by capacity that ALREADY EXISTS (survivors ≤100%).
 *      Autoscaling is NOT a failover plan (cold-start stampede on the cloud's worst day).
 *   2. NO control-plane on the failover path — anycast reconverges automatically;
 *      health checks drive a LOCAL, pre-agreed routing change; clients retry a
 *      STATIC list of regional endpoints. Nothing waits on a deploy or a meeting.
 *   3. ZERO new decisions at failure time — data posture (stale-read vs queue vs
 *      503, money fails closed) is pre-decided and game-dayed. Humans show up at
 *      minute 3 to make exactly ONE pre-scoped call: promote or wait.
 *
 * We run 3 region-homed regions, cut one, and narrate the timeline with numbers —
 * then show the SAME cut at 90% utilization overloading the survivors (why the
 * headroom is the RTO insurance premium, not waste).
 */

import { log } from "../lib/log.ts";

interface Region { name: string; capacity: number; homedLoad: number; alive: boolean }

/** Absorb the dead region's READ load across survivors; return peak survivor utilization %. */
function failoverUtil(regions: Region[], deadName: string, readShare: number): number {
  const dead = regions.find((r) => r.name === deadName)!;
  const survivors = regions.filter((r) => r.alive && r.name !== deadName);
  const absorbable = dead.homedLoad * readShare; // reads can serve from replicas; writes queue for promotion
  const perSurvivor = absorbable / survivors.length;
  let peak = 0;
  for (const s of survivors) {
    const util = ((s.homedLoad + perSurvivor) / s.capacity) * 100;
    peak = Math.max(peak, util);
  }
  return peak;
}

function drill(utilizationPct: number) {
  const cap = 100;
  const homed = (utilizationPct / 100) * cap;
  const regions: Region[] = [
    { name: "us-east", capacity: cap, homedLoad: homed, alive: true },
    { name: "us-west", capacity: cap, homedLoad: homed, alive: true },
    { name: "eu-west", capacity: cap, homedLoad: homed, alive: true },
  ];
  const READ_SHARE = 0.7; // 70% of the dead region's traffic is reads (serveable from replicas)

  log(`─── Fiber-cut drill at ${utilizationPct}% steady utilization ───`);
  log(`   3 regions, each capacity ${cap}, each serving ${homed} units of HOMED traffic (its own entities)`);

  log("   T+0s   us-east loses transit 💥");
  log("           → anycast: users' packets reconverge to next-nearest PoPs (seconds, AUTOMATIC)");
  regions[0].alive = false;
  log("   T+5–30s health checks mark us-east origins dead; PoPs route to survivors per STATIC table");

  const peak = failoverUtil(regions, "us-east", READ_SHARE);
  log(`           survivors absorb us-east's reads → peak survivor utilization = ${peak.toFixed(0)}%`);
  if (peak <= 100) {
    log(`           ✓ under 100% — capacity was ALREADY THERE; no autoscaler, no human capacity math`);
  } else {
    log(`           ❌ OVER 100% — survivors overload; you needed the headroom you cut. RTO broken.`);
  }
  log("   T+1–5min us-east-homed entities: reads serve STALE from replicas (flagged);");
  log("           writes QUEUE or 503 per pre-decided posture (money fails closed)");
  log("   T+3min  humans join → exactly ONE pre-scoped decision: PROMOTE a replica or WAIT");
  log("           (RPO-gap reconciliation per runbook; old primary FENCED before promotion)");
  log("");
  return peak;
}

function main() {
  log("═══ A) The design as built: ≤66% utilization (statically stable) ═══\n");
  const good = drill(66);

  log("═══ B) The same cut with the 'idle' headroom cut to save money: 90% utilization ═══\n");
  const bad = drill(90);

  log("═══ The one number that ends the budget debate ═══");
  log(`   at 66% util → survivor peak ${good.toFixed(0)}%  ✓ region loss is a non-event`);
  log(`   at 90% util → survivor peak ${bad.toFixed(0)}%  ❌ region loss is an outage`);
  log("");
  log("Say it like this (the L6 tells):");
  log("   • 'RTO/RPO first — the topology is arithmetic, not a preference.'");
  log("   • 'Conflicts are created by topology, not resolved by it — I home each entity to one");
  log("      region so same-entity conflicts are unrepresentable, then merge only what commutes.'");
  log("   • 'Static stability: the failover consumes only decisions and capacity provisioned BEFORE");
  log("      the failure — the human shows up at minute three to make exactly one pre-scoped call.'");
  log("   • 'Each region runs at two-thirds so losing one is a capacity non-event — that headroom is");
  log("      the premium on the RTO we promised, and it has a number. Cut it and we rewrite the RTO.'");
  process.exit(0);
}

main();
