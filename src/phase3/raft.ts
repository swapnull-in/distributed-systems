/**
 * Phase 3 — CONSENSUS: a tiny Raft. Run: npm run phase3
 *
 * Consensus = get N nodes to agree on ONE ordered log despite failures. It
 * underpins leader election, config stores, locks, and strongly-consistent DBs.
 * Reach for it ONLY when correctness needs a single agreed value/order —
 * otherwise you pay the coordination tax for nothing.
 *
 * Raft's three ideas, all here:
 *   1. TERMS — a logical clock; at most one leader per term (stale leaders lose).
 *   2. ELECTION — a candidate needs a MAJORITY of the WHOLE cluster to win, so a
 *      minority partition can NEVER elect a leader → split-brain is impossible.
 *   3. REPLICATION — an entry commits only once a MAJORITY has stored it; a
 *      minority leader can append but can NEVER commit.
 *
 * We elect a leader, replicate an entry, then partition the leader into the
 * minority and watch: it keeps its title but cannot commit; the majority elects a
 * new leader at a higher term; on heal the old leader steps down and its
 * uncommitted entry is overwritten. Safety never breaks — only availability blips.
 */

import { log } from "../lib/log.ts";

interface Entry { term: number; cmd: string }

class Node {
  term = 0;
  role: "follower" | "candidate" | "leader" = "follower";
  votedFor: number | null = null;
  log: Entry[] = [];
  commitIndex = -1;
  id: number;
  constructor(id: number) { this.id = id; }
}

class RaftCluster {
  nodes: Node[];
  n: number;
  private reachable: Set<number>;
  constructor(n: number) {
    this.n = n;
    this.nodes = Array.from({ length: n }, (_, i) => new Node(i));
    this.reachable = new Set(this.nodes.map((x) => x.id));
  }
  private majority() { return Math.floor(this.n / 2) + 1; }
  partition(side: number[]) { this.reachable = new Set(side); }
  heal() { this.reachable = new Set(this.nodes.map((x) => x.id)); }
  private peersOf(id: number) { return this.nodes.filter((x) => x.id !== id && this.reachable.has(x.id) && this.reachable.has(id)); }

  /** Run an election started by `candidateId` (as if its timer fired). */
  elect(candidateId: number): boolean {
    const c = this.nodes[candidateId];
    c.term++; c.role = "candidate"; c.votedFor = c.id;
    let votes = 1; // votes for itself
    for (const peer of this.peersOf(c.id)) {
      const lastTerm = c.log.at(-1)?.term ?? -1;
      const peerLastTerm = peer.log.at(-1)?.term ?? -1;
      const upToDate = lastTerm > peerLastTerm || (lastTerm === peerLastTerm && c.log.length >= peer.log.length);
      if (c.term > peer.term && upToDate) { peer.term = c.term; peer.votedFor = c.id; peer.role = "follower"; votes++; }
    }
    const won = votes >= this.majority();
    log(`   node ${c.id} runs election for term ${c.term}: ${votes}/${this.n} votes → ${won ? "LEADER" : "lost (no majority reachable)"}`);
    if (won) c.role = "leader"; else c.role = "follower";
    return won;
  }

  /** Leader appends a command and tries to replicate + commit it. */
  propose(leaderId: number, cmd: string): boolean {
    const l = this.nodes[leaderId];
    if (l.role !== "leader") { log(`   node ${l.id} is not leader — refuses "${cmd}"`); return false; }
    const entry: Entry = { term: l.term, cmd };
    l.log.push(entry);
    let stored = 1; // leader has it
    for (const peer of this.peersOf(l.id)) {
      if (peer.term <= l.term) { peer.term = l.term; peer.log = [...l.log]; stored++; }
    }
    const committed = stored >= this.majority();
    if (committed) { for (const x of this.nodes) if (this.reachable.has(x.id)) x.commitIndex = x.log.length - 1; }
    log(`   leader ${l.id} proposes "${cmd}" (term ${l.term}): stored on ${stored}/${this.n} → ${committed ? "COMMITTED ✓" : "NOT committed (no majority) ✗"}`);
    return committed;
  }

  leader() { return this.nodes.find((x) => x.role === "leader"); }
  dump() { return this.nodes.map((x) => `n${x.id}[t${x.term},${x.role[0]},log=${x.log.map((e) => e.cmd).join(",") || "-"},ci=${x.commitIndex}]`).join("\n     "); }
}

function main() {
  const c = new RaftCluster(5);

  log("═══ A) Elect a leader and commit an entry ═══");
  c.elect(0);
  c.propose(0, "x=1");
  log("");

  log("═══ B) Partition the leader into the MINORITY {0,1} | majority {2,3,4} ═══");
  c.partition([0, 1]);
  log("   old leader (node 0) is now in a 2-node minority. It tries to commit:");
  c.propose(0, "x=2"); // appends locally but cannot reach majority → NOT committed
  log("   meanwhile the majority side {2,3,4} times out and elects a new leader:");
  c.partition([2, 3, 4]);
  c.elect(2);          // higher term, has majority
  c.propose(2, "x=99"); // commits on the majority side
  log("");

  log("═══ C) Heal the partition ═══");
  c.heal();
  // Old leader (node 0) learns of the higher term via the new leader replicating.
  const winner = c.nodes[2];
  for (const x of c.nodes) if (x.term < winner.term) { x.term = winner.term; x.role = "follower"; x.log = [...winner.log]; x.commitIndex = winner.log.length - 1; }
  log("   node 0 sees term " + winner.term + " > its own → steps down, its uncommitted x=2 is OVERWRITTEN.");
  log("   final cluster state:");
  log("     " + c.dump());
  log("");
  log("Takeaways:");
  log("   • A minority CANNOT elect a leader or commit → split-brain is structurally impossible.");
  log("   • The uncommitted write on the old leader was never acked to a client — no lie was told (SAFETY held).");
  log("   • Odd sizes (3,5,7): majority survives one/two failures; going past 5–7 just slows every commit.");
  log("   • Naive 'read from the leader' is NOT linearizable — a partitioned ex-leader serves stale reads");
  log("     until it learns it lost; use ReadIndex (quorum check) or a leader lease.");
  process.exit(0);
}

main();
