/**
 * Phase 2 — CAP: what a PARTITION actually forces. Run: npm run phase2
 *
 * CAP is not "pick 2 of 3." P (partition tolerance) is not optional on a real
 * network — partitions WILL happen. So the only real choice is, DURING a
 * partition, do you keep Consistency (linearizable) or Availability?
 *   • CP: the minority side REFUSES writes to avoid divergence (etcd, HBase).
 *   • AP: both sides keep accepting, DIVERGE, and reconcile later (Dynamo, Cassandra).
 *
 * And CAP hides latency. PACELC adds the part that actually bites: Else (no
 * partition) you still trade Latency vs Consistency on every request — waiting
 * for a quorum ack costs milliseconds on the happy path, every time.
 *
 * We run a 5-node cluster with quorum writes (W=3 of N=5, so R+W>N), then cut it
 * into a 3-2 partition and show the SAME cluster behaving CP or AP by policy.
 */

import { log } from "../lib/log.ts";

type Mode = "CP" | "AP";

class Cluster {
  private value = new Map<number, string>(); // nodeId -> its copy
  private reachable = new Set<number>();      // current network view (one side)
  private n: number;

  constructor(n: number) {
    this.n = n;
    for (let i = 0; i < n; i++) { this.value.set(i, "v0"); this.reachable.add(i); }
  }

  /** Simulate a partition: `side` is the set of nodes that can talk to each other. */
  partition(side: number[]) { this.reachable = new Set(side); }
  heal() { this.reachable = new Set(this.value.keys()); }

  private quorum() { return Math.floor(this.n / 2) + 1; } // 3 of 5

  /** A quorum write from the perspective of whoever can reach `this.reachable`. */
  write(v: string, mode: Mode): boolean {
    const acks = this.reachable.size;
    if (mode === "CP" && acks < this.quorum()) {
      log(`      CP: only ${acks}/${this.n} reachable (< quorum ${this.quorum()}) → REJECT write, stay consistent`);
      return false;
    }
    // AP (or CP with quorum): write to whoever is reachable.
    for (const id of this.reachable) this.value.set(id, v);
    log(`      ${mode}: wrote "${v}" to ${acks} reachable node(s)${mode === "AP" && acks < this.quorum() ? "  ⚠ minority accepted → will diverge" : ""}`);
    return true;
  }

  snapshot() { return [...this.value.entries()].map(([id, v]) => `n${id}=${v}`).join(" "); }
}

function cp() {
  log("═══ A) CP posture — minority refuses, no divergence ═══");
  const c = new Cluster(5);
  c.partition([0, 1, 2]);          // majority side
  log("   Partition: {0,1,2} | {3,4}. Client on the MINORITY side {3,4} writes:");
  c.partition([3, 4]);
  c.write("v1", "CP");             // minority: rejected
  c.partition([0, 1, 2]);
  log("   Client on the MAJORITY side {0,1,2} writes:");
  c.write("v1", "CP");            // majority: accepted
  c.heal();
  log(`   healed → ${c.snapshot()}  ✓ one truth, minority writes were refused (availability sacrificed)`);
  log("");
}

function ap() {
  log("═══ B) AP posture — both sides accept, then diverge ═══");
  const c = new Cluster(5);
  c.partition([0, 1, 2]);
  log("   Partition: {0,1,2} | {3,4}. BOTH sides take writes:");
  c.write("east", "AP");
  c.partition([3, 4]);
  c.write("west", "AP");
  log(`   during partition → ${c.snapshot()}  ⚠ two versions live at once`);
  c.heal();
  log("   healed → must RECONCILE (LWW / vector clocks / CRDT — see phase 7).");
  log(`   (availability kept: nobody got an error; the bill is conflict resolution)`);
  log("");
}

function main() {
  cp();
  ap();
  log("Say it like this in the room:");
  log("   • 'P isn't optional — I'm choosing C vs A only DURING a partition, per data path.'");
  log("   • 'CP for the ledger and locks; AP + reconcile for the feed and presence.'");
  log("   • Lead with PACELC: partitions are rare, but the latency-vs-consistency");
  log("     tradeoff (the E-L-C clause) is paid on EVERY normal request.");
  process.exit(0);
}

main();
