/**
 * Phase 9 — SESSION GUARANTEES: read-your-writes & monotonic reads. Run: npm run phase9
 *
 * The cheap fix for ~90% of "where did my write go?" bugs under eventual
 * consistency — WITHOUT paying for full linearizability everywhere.
 *
 * Setup: a PRIMARY accepts writes; each write bumps a version (an LSN — log
 * sequence number). One or more ASYNC REPLICAS lag behind (replica LSN < primary
 * LSN) until they "catch up" on a replication tick. A read from a lagging replica
 * returns its STALE value. That lag is where the two ugliest UX bugs live:
 *
 *   • "I just posted it, where is it?"  — you write to the primary (LSN N→N+1),
 *     then a load balancer routes your very next read to a replica still at LSN N.
 *     Your own write is INVISIBLE to you. This is a READ-YOUR-WRITES violation.
 *   • "Time went backwards"             — two successive reads hit replica@5 then
 *     replica@3; the second read is OLDER than the first, so a deleted item
 *     reappears. This is a MONOTONIC-READS violation.
 *
 * THE FIX is per-session (sticky), not global. The session carries a small LSN
 * TOKEN — the highest LSN it has already observed — and the router honors it:
 *   • read-your-writes: after a write returns LSN W, route reads only to a replica
 *     with LSN ≥ W (or to the primary). You always see at least your own write.
 *   • monotonic reads: remember the LSN of your last read as a FLOOR; never accept
 *     a read from a replica below that floor (or pin the session to one replica).
 * Both cost a per-session integer and some routing logic — FAR cheaper than making
 * every read linearizable (a global order, quorum reads, coordination on the hot
 * path). You buy consistency only where a human will notice.
 *
 * There are FOUR session guarantees; we demo the two that bite hardest. The other
 * two (name-drop them): MONOTONIC WRITES (your writes apply in the order you issued
 * them) and WRITES-FOLLOW-READS (a write that depends on a read lands after the
 * value it read — e.g. your reply can't be ordered before the post it answers).
 *
 * Say it like this:
 *   • "Eventual consistency's worst UX bugs — 'my own write vanished', 'time went
 *      backwards' — are session-consistency bugs, and I fix them per session with an
 *      LSN token, not by paying for linearizability everywhere."
 *   • "Read-your-writes: route reads to a replica at or past the LSN my write returned."
 *   • "Monotonic reads: pin the session or track a floor LSN so reads never regress."
 *   • "The other two session guarantees are monotonic-writes and writes-follow-reads."
 */

import { log } from "../lib/log.ts";

/** A node holds a value stamped with the LSN at which that value was written. */
interface Node {
  name: string;
  lsn: number;   // highest write applied here
  value: string; // the value as of `lsn`
}

/**
 * A tiny cluster: one primary that owns the write log, and async replicas that
 * trail behind. Replication is EXPLICIT (replicate()) so "time" is a counter we
 * drive by hand — nothing depends on Date.now()/Math.random().
 */
class Cluster {
  primary: Node;
  replicas: Node[];

  constructor(initialValue: string, replicaCount: number) {
    this.primary = { name: "primary", lsn: 0, value: initialValue };
    this.replicas = [];
    for (let i = 0; i < replicaCount; i++) {
      this.replicas.push({ name: `replica-${i + 1}`, lsn: 0, value: initialValue });
    }
  }

  /** A write hits the primary, bumps the LSN, and returns the new LSN (the token). */
  write(value: string): number {
    this.primary.lsn += 1;
    this.primary.value = value;
    return this.primary.lsn;
  }

  /** Advance one replica up to a given LSN (as far as the primary has gone). */
  replicate(replicaIndex: number, upToLsn: number): void {
    const r = this.replicas[replicaIndex];
    if (upToLsn > this.primary.lsn) upToLsn = this.primary.lsn;
    if (upToLsn <= r.lsn) return;
    r.lsn = upToLsn;
    r.value = this.primary.value; // value as of the primary's current LSN (good enough for the demo)
  }
}

/** A per-user session. Its token is the highest LSN this user has observed. */
class Session {
  user: string;
  token: number; // read-your-writes floor: my last write's LSN
  readFloor: number; // monotonic-reads floor: highest LSN I've ever read
  pinnedReplica: number | null; // monotonic-reads via stickiness

  constructor(user: string) {
    this.user = user;
    this.token = 0;
    this.readFloor = 0;
    this.pinnedReplica = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────

function theBug() {
  log("═══ A) THE BUG — you don't see your own write (read-your-writes violation) ═══");
  const c = new Cluster("<empty>", 1);
  log(`   start: primary@${c.primary.lsn}="${c.primary.value}", replica-1@${c.replicas[0].lsn}="${c.replicas[0].value}"`);

  const w = c.write("hello world (my new post)");
  log(`   Alice writes to primary → primary now @${c.primary.lsn}, write returned LSN=${w}`);
  log(`   ...but replication hasn't ticked yet: replica-1 still @${c.replicas[0].lsn}`);

  // Naive router: send the next read to "some" replica, ignoring the write's LSN.
  const seen = c.replicas[0];
  log(`   Alice's next read is routed to ${seen.name}@${seen.lsn} → "${seen.value}"`);
  log(`   ❌ "I just posted it, where is it?" — her own write is invisible (replica@${seen.lsn} < token@${w})`);
  log("");
}

function readYourWrites() {
  log("═══ B) READ-YOUR-WRITES — route by the session's LSN token ═══");
  const c = new Cluster("<empty>", 2);
  const s = new Session("Alice");

  s.token = c.write("hello world (my new post)");
  log(`   Alice writes → primary@${c.primary.lsn}; session token = ${s.token}`);

  // Replication is uneven: replica-1 catches up, replica-2 still lags.
  c.replicate(0, c.primary.lsn); // replica-1 → caught up
  // replica-2 left behind on purpose
  log(`   replication ticks unevenly: replica-1@${c.replicas[0].lsn}, replica-2@${c.replicas[1].lsn}`);

  // Router: pick ONLY a node whose LSN >= token (else fall back to primary).
  const target =
    c.replicas.find((r) => r.lsn >= s.token) ?? c.primary;
  log(`   router honors token=${s.token}: skips any replica < ${s.token}, picks ${target.name}@${target.lsn}`);
  log(`   Alice reads → "${target.value}"`);
  const ok = target.lsn >= s.token;
  log(`   ${ok ? "✓" : "❌"} she sees her own write (chosen node LSN ${target.lsn} ≥ token ${s.token})`);
  log("");
}

function monotonicReads() {
  log("═══ C) MONOTONIC READS — reads must not go backwards in time ═══");
  // Timeline: item was created (LSN 4), then DELETED (LSN 5). Two replicas sit at
  // different points in that history: replica-fast saw the delete, replica-slow didn't.
  const cFast: Node = { name: "replica-fast", lsn: 5, value: "<item deleted>" };
  const cSlow: Node = { name: "replica-slow", lsn: 3, value: "item is HERE" };

  log("   history: item created @LSN4, then DELETED @LSN5");
  log(`   ${cFast.name}@${cFast.lsn}="${cFast.value}"   ${cSlow.name}@${cSlow.lsn}="${cSlow.value}"`);
  log("");

  // --- The violation: successive reads land on fast, then slow. ---
  log("   -- violation (no guarantee): load balancer sends read 1 → fast, read 2 → slow --");
  const s1 = new Session("Bob");
  const r1 = cFast; // read 1
  s1.readFloor = Math.max(s1.readFloor, r1.lsn);
  log(`   read 1 → ${r1.name}@${r1.lsn}: "${r1.value}"  (Bob: 'ok, it's gone')`);
  const r2 = cSlow; // read 2 — OLDER than read 1
  log(`   read 2 → ${r2.name}@${r2.lsn}: "${r2.value}"  (LSN ${r2.lsn} < ${s1.readFloor})`);
  log(`   ❌ time went backwards — the deleted item REAPPEARED`);
  log("");

  // --- The fix: track a read floor; reject any replica below it. ---
  log("   -- fix: session tracks a read FLOOR; never accept a replica below it --");
  const s2 = new Session("Bob");
  const reads = [cFast, cSlow]; // same routing attempts as before
  for (let i = 0; i < reads.length; i++) {
    const candidate = reads[i];
    if (candidate.lsn < s2.readFloor) {
      log(`   read ${i + 1} → ${candidate.name}@${candidate.lsn} REJECTED (below floor ${s2.readFloor}) → retry on a fresher node / primary`);
      continue;
    }
    s2.readFloor = candidate.lsn;
    log(`   read ${i + 1} → ${candidate.name}@${candidate.lsn}: "${candidate.value}"  (floor raised to ${s2.readFloor})`);
  }
  log(`   ✓ reads only move forward — the delete stays deleted (floor never drops)`);
  log("   (equivalently: PIN the session to one replica so its LSN is monotonic by construction)");
  log("");
}

function main() {
  theBug();
  readYourWrites();
  monotonicReads();
  log("Takeaways:");
  log("   • Async replicas lag: a read right after your write can miss it, and two reads can regress.");
  log("   • READ-YOUR-WRITES: carry the write's LSN as a session token; read only from a node LSN ≥ token.");
  log("   • MONOTONIC READS: track a floor LSN (or pin to one replica); never accept a read below it.");
  log("   • These are PER-SESSION guarantees enforced by a small LSN token — far cheaper than global");
  log("     linearizability (quorum reads, coordination on every read). Buy consistency where humans notice.");
  log("   • The other two session guarantees: MONOTONIC-WRITES and WRITES-FOLLOW-READS.");
  process.exit(0);
}

main();
