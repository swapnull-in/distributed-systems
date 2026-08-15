/**
 * Phase 12 — LEADERLESS QUORUMS: R + W > N and read-repair. Run: npm run phase12
 *
 * Phase 2 modeled CAP with a WRITE quorum only. This goes deeper on the READ
 * side — the Dynamo/Cassandra/Riak model where there is NO leader. Any replica
 * takes reads and writes; the client (or a coordinator) talks to several at once
 * and uses the counts to decide.
 *
 * N = replicas that hold each key. W = replicas that must ACK a write. R =
 * replicas that must answer a read. The one inequality that makes it safe:
 *
 *        R + W > N   ⇒   the read set and the write set MUST overlap.
 *
 * Pigeonhole: a write touched W of N replicas; a read touches R of N. If
 * R + W > N, the two subsets can't be disjoint — at least one replica is in
 * BOTH, so every quorum read sees at least one copy of the latest acked write.
 * Attach a version to each value, and the reader just keeps the highest version.
 *
 * READ-REPAIR: on that read, any replica that answered with a stale (lower)
 * version gets the fresh value written back to it, on the read path. Popular
 * keys self-heal just by being read.
 *
 * Drop below the line (R + W ≤ N) and the sets can be disjoint: fast, cheaper,
 * but a read can miss the latest write and return stale data.
 *
 * We run N=3 and show: (A) W=2,R=2 → guaranteed overlap, read sees v2;
 * (B) read-repair heals the lagging replica; (C) W=1,R=1 → read misses v2.
 *
 * Say it like this:
 *   • "R + W > N forces the read set and write set to overlap, so a quorum read
 *      always sees the latest acknowledged write."
 *   • "Read-repair heals stale replicas on the read path — hot keys self-correct."
 *   • "Sloppy quorum + hinted handoff trade consistency for availability under
 *      partition; anti-entropy (Merkle trees) sweeps up the cold keys in the back."
 */

import { log } from "../lib/log.ts";

interface Versioned {
  value: string;
  version: number;
}

/** A leaderless key-value store: N peer replicas, no leader. */
class QuorumStore {
  private replicas: Versioned[] = [];
  private n: number;

  constructor(n: number, seed: Versioned) {
    this.n = n;
    for (let i = 0; i < n; i++) this.replicas[i] = { ...seed };
  }

  get N(): number {
    return this.n;
  }

  /** Direct peek at one replica (for narration, not part of the protocol). */
  peek(id: number): Versioned {
    return this.replicas[id];
  }

  snapshot(): string {
    return this.replicas
      .map((r, id) => `r${id}=${r.value}@v${r.version}`)
      .join("  ");
  }

  /** Highest version wins — a replica never regresses to an older version. */
  private apply(id: number, incoming: Versioned): void {
    if (incoming.version > this.replicas[id].version) {
      this.replicas[id] = { ...incoming };
    }
  }

  /**
   * Quorum WRITE: push {value, version} to the chosen `targets`. In real life
   * you'd fan out to all N and wait for W acks; here `targets` IS the set that
   * acked (the rest were down/slow and simply lag behind).
   */
  write(targets: number[], incoming: Versioned): void {
    for (const id of targets) this.apply(id, incoming);
    log(
      `      WRITE ${incoming.value}@v${incoming.version} → replicas {${targets.join(",")}} acked (W=${targets.length})`,
    );
  }

  /**
   * Quorum READ from `responders`: return the newest version any of them holds,
   * then READ-REPAIR every responder that came back stale.
   */
  read(responders: number[]): Versioned {
    const replies = responders.map((id) => ({ id, v: this.replicas[id] }));
    for (const { id, v } of replies) {
      log(`      READ  r${id} → ${v.value}@v${v.version}`);
    }

    // Newest version seen across the responders wins.
    let newest = replies[0].v;
    for (const { v } of replies) if (v.version > newest.version) newest = v;

    // Read-repair: any responder behind `newest` gets it written back, now.
    for (const { id, v } of replies) {
      if (v.version < newest.version) {
        this.apply(id, newest);
        log(
          `      READ-REPAIR r${id}: ${v.value}@v${v.version} was stale → healed to ${newest.value}@v${newest.version}`,
        );
      }
    }
    return newest;
  }
}

function overlapGuaranteed() {
  log("═══ A) R + W > N guarantees the read set overlaps the write set ═══");
  const store = new QuorumStore(3, { value: "v1", version: 1 });
  log(`   N=3, start: ${store.snapshot()}`);
  log("   Config: W=2, R=2  → 2 + 2 = 4 > 3 ✓");

  // Write v2 to only 2 of 3 replicas — r2 was down/slow and still holds v1.
  log("   Client writes v2 but replica r2 is slow/down, so only {0,1} ack:");
  store.write([0, 1], { value: "v2", version: 2 });
  log(`   after write: ${store.snapshot()}   (r2 still lags at v1)`);

  // Read a quorum of 2. Try the read set that INCLUDES the lagging replica.
  const readSet = [1, 2];
  const writeSet = [0, 1];
  const overlap = readSet.filter((id) => writeSet.includes(id));
  log(`   Quorum read of {${readSet.join(",")}} (deliberately includes the laggard r2):`);
  const result = store.read(readSet);

  log(
    `   Pigeonhole: writeSet={${writeSet.join(",")}} ∩ readSet={${readSet.join(",")}} = {${overlap.join(",")}} — cannot be empty when R+W>N`,
  );
  log(
    `   → read returns ${result.value}@v${result.version}  ✓ latest acked write is visible, even though a laggard answered`,
  );
  log("");
}

function readRepairHeals() {
  log("═══ B) Read-repair heals the stale replica on the read path ═══");
  const store = new QuorumStore(3, { value: "v1", version: 1 });
  store.write([0, 1], { value: "v2", version: 2 });
  log(`   Same setup — r2 lags: ${store.snapshot()}`);

  log("   The read above touched r2 and noticed it was behind. Watch it heal:");
  store.read([1, 2]);
  log(`   after read-repair: ${store.snapshot()}  ✓ all 3 replicas converged to v2`);
  log("   (no background job ran — the READ itself repaired the divergence)");
  log("");
}

function belowTheLineMisses() {
  log("═══ C) R + W ≤ N can miss the latest write (fast, but stale-prone) ═══");
  const store = new QuorumStore(3, { value: "v1", version: 1 });
  log(`   N=3, start: ${store.snapshot()}`);
  log("   Config: W=1, R=1  → 1 + 1 = 2 ≤ 3 ✗ (no overlap guarantee)");

  const writeSet = [0];
  const readSet = [2];
  log("   Client writes v2 to just replica r0 (W=1):");
  store.write(writeSet, { value: "v2", version: 2 });
  log(`   after write: ${store.snapshot()}`);

  log(`   Quorum read of just {${readSet.join(",")}} (R=1):`);
  const result = store.read(readSet);
  const overlap = readSet.filter((id) => writeSet.includes(id));
  log(
    `   writeSet={${writeSet.join(",")}} ∩ readSet={${readSet.join(",")}} = {${overlap.join(",") || "∅"}} — DISJOINT, so no v2 in the read set`,
  );
  log(
    `   → read returns ${result.value}@v${result.version}  ❌ STALE — this is the 'fast but can read stale' tradeoff`,
  );
  log("");
}

function otherMechanisms() {
  log("═══ The rest of the leaderless toolbox (name-drop these) ═══");
  log("   • SLOPPY QUORUM + HINTED HANDOFF: during a partition, if the home");
  log("     replicas are unreachable, accept the write on SUBSTITUTE nodes so it");
  log("     still gets W acks (stay available). The substitute holds a 'hint' and");
  log("     HANDS OFF the data when the home node returns. Trades consistency for");
  log("     availability — the W acks weren't all from the 'real' replicas.");
  log("   • ANTI-ENTROPY (Merkle trees): a background job compares per-range");
  log("     Merkle hashes between replicas and ships only the differing ranges.");
  log("     Read-repair fixes HOT keys on the read path; anti-entropy sweeps up");
  log("     the COLD keys that are rarely read. Together they close the gap.");
  log("");
}

function main() {
  overlapGuaranteed();
  readRepairHeals();
  belowTheLineMisses();
  otherMechanisms();
  log("Takeaways:");
  log("   • R + W > N forces the read set and write set to OVERLAP — a quorum read");
  log("     always sees the latest acknowledged write (pigeonhole, not luck).");
  log("   • READ-REPAIR heals stale replicas on the read path; hot keys self-heal.");
  log("   • R + W ≤ N is fast and cheap but can read stale — a deliberate tradeoff.");
  log("   • SLOPPY QUORUM + HINTED HANDOFF trade consistency for availability under");
  log("     partition; ANTI-ENTROPY (Merkle trees) repairs the cold keys in the back.");
  process.exit(0);
}

main();
