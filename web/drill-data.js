/** Drill data — mined from Core Course/02-distributed-systems.md (+02b). Loaded by index.html's Drill panel. */
window.DRILL = {
  module: "Module 02 — Distributed Systems",
  source: "Core Course/02-distributed-systems.md + 02b-multi-region-resilience.md",
  cheats: [
    "<b>ACID-C ≠ CAP-C</b> — invariant preservation within a transaction vs linearizability across replicas. Say the distinction out loud when CAP comes up.",
    "<b>Snapshot Isolation</b> prevents phantoms but <em>not write skew</em> — use <code>SERIALIZABLE</code> or <code>SELECT ... FOR UPDATE</code> for any cross-row invariant.",
    "<b>CAP:</b> P is mandatory in a real network — you choose C or A <em>only during a partition</em>; 'CA' means single-node. Lead with <b>PACELC</b>: the Else clause (Latency vs Consistency) is paid on every request.",
    "<b>FLP</b> — no deterministic consensus is guaranteed in an async system with even one crash fault; real systems escape via timeouts + randomization. It is a <em>liveness</em> result, not a safety one.",
    "Reach for <b>consensus</b> only when you need a single agreed value or order: leader election, locks, config, membership, a linearizable log — never for plain read-scaling replication.",
    "<b>Raft:</b> majority quorum, odd clusters (3 tolerates 1, 5 tolerates 2), randomized election timeouts. Linearizable reads need <b>ReadIndex or a leader lease</b> — a partitioned ex-leader serves stale reads.",
    "<b>Quorum:</b> R + W > N guarantees overlap, <em>not</em> linearizability — and sloppy quorum breaks even the overlap. You still need read-repair and a conflict-resolution rule.",
    "<b>Distributed locks:</b> the lock gives liveness and uniqueness; safety comes from <b>fencing tokens validated at the resource</b> (reject any token below the highest seen). Redlock alone is not safe for correctness.",
    "<b>2PC</b> is atomic but blocking — a dead coordinator leaves in-doubt participants holding locks that fan out. <b>Saga</b> scales across services but sacrifices isolation: compensations + idempotency + outbox.",
    "<b>No exactly-once on the wire</b> — at-least-once delivery + idempotent consumers = <em>effectively-once</em>. The transactional <b>outbox</b> (CDC via Debezium) solves the dual-write problem.",
    "<b>Resilience trio:</b> timeout + circuit breaker (trip on <em>latency</em>, not just errors) + bulkhead — plus backoff, full jitter, and a <b>retry budget</b> (~10-20%) to prevent metastable retry storms.",
    "<b>Clocks:</b> never wall-clock for ordering, LWW, or leases. Lamport orders but cannot detect concurrency; vector clocks can but cost O(N); <b>HLC</b> is the pragmatic default; TrueTime = GPS hardware + commit-wait.",
    "<b>Conflicts are created by topology, not resolved by it</b> — home each entity to one region so same-entity conflicts are unrepresentable; merge only state that genuinely commutes. <em>LWW is a data-loss policy wearing a tie-breaker's clothes.</em>",
    "<b>Static stability:</b> regions run at ≤66% for N+1, no control plane on the failover path, zero new decisions at failure time — the human shows up at minute three to make exactly one pre-scoped call (promotion)."
  ],
  cards: [
    {
      topic: "CAP",
      q: "Explain CAP and why a 'CA' system doesn't really exist.",
      a: "During a partition you cannot have both linearizable consistency and availability, and partitions are unavoidable — so P isn't optional; you're choosing C vs A only during a partition. A 'CA' system is just a single-node database with nothing to partition. The better model is PACELC: even with no partition you trade latency vs consistency on every request, which is where most real decisions live. In a real design, pick per dataset: AP/EL for the feed, CP/EC for the ledger — same system, two postures."
    },
    {
      topic: "locks",
      q: "Is a distributed lock safe? How would you build a safe one?",
      a: "No lock is safe on its own: the holder can be paused (GC, VM pause) past its lease without knowing it lost the lock. The lock service provides liveness and uniqueness; safety must come from fencing tokens — a monotonically increasing token per grant that the protected resource validates, rejecting anything below the highest seen. That's why Redlock alone is unsafe for correctness: it has no fencing. Scale to the requirement: for efficiency-only dedup, a plain Redis lock is fine — don't over-build."
    },
    {
      topic: "transactions",
      q: "Walk me through 2PC and its failure modes. When would you use Saga instead?",
      a: "2PC: coordinator sends prepare, participants durably lock and vote; all-yes means the coordinator logs commit and broadcasts. The fatal flaw is blocking — a participant that voted yes is in-doubt, holding locks until it hears the decision; if the coordinator dies between phases those locks fan out and stall other transactions. Use 2PC only inside a tightly-coupled single-org stack (XA). For microservices use a Saga — local transactions plus compensations, orchestrated for traceability — and flag up front that the hard part is compensations and visible intermediate state, backed by idempotency keys and an outbox."
    },
    {
      topic: "CRDTs",
      q: "Design conflict resolution for a collaborative editor / chat app.",
      a: "First look for what can be immutable — message bodies never change, so they never conflict; that's the cheapest strategy. For the rest use CRDTs: a sequence CRDT (Yjs/Automerge) for text, OR-Sets for reactions and membership, PN-Counters for counts — concurrent ops merge deterministically and always converge with no consensus on the write path, giving low latency and offline support. Earmark the costs early: metadata growth (tombstones, position ids) needs GC, and CRDTs guarantee convergence, not intent — global invariants like balance >= 0 still need consensus."
    },
    {
      topic: "retries",
      q: "How do you prevent retry storms / cascading failures?",
      a: "Retries multiply load at every layer, so during an outage they can become the majority of traffic and tip a brownout into a metastable failure — the system stays down after the trigger clears because retry load is self-sustaining. Defenses: exponential backoff with full jitter, a retry budget capping retries at ~10-20% of traffic, retrying only idempotent ops on retriable errors, and retrying at one layer, not stacked. Combine with circuit breakers that trip on latency (a slow-but-200 dependency silently eats your threads), timeouts, and bulkheads to isolate pools per dependency."
    },
    {
      topic: "consensus",
      q: "Why is consensus hard? What does Raft guarantee?",
      a: "FLP: in a fully asynchronous system with even one crash fault, no deterministic protocol can guarantee termination, because you can't distinguish a slow node from a dead one. Real systems escape via partial synchrony — timeouts plus randomization — keeping safety always and liveness probabilistically. Raft commits an entry once a majority persists it, and the up-to-date-log voting rule guarantees a new leader has all committed entries: always safe, eventually live. One flag: linearizable reads need ReadIndex or a leader lease, or a partitioned ex-leader serves stale data."
    },
    {
      topic: "consistency",
      q: "Eventual consistency is too weak for our UX. What's the strongest model we can keep while staying available under partition?",
      a: "Causal consistency — it preserves cause-and-effect ordering (a reply never precedes its parent) and it's the strongest model achievable in an always-available, partition-tolerant system; anything stronger violates CAP. Implement by propagating dependency metadata so replicas apply writes in causal order. But start cheaper: read-your-writes and monotonic reads fix ~90% of the jarring UX bugs at near-zero coordination cost — add full causal only when cross-user ordering becomes a real complaint."
    },
    {
      topic: "clocks",
      q: "How does Spanner give global strong consistency, and what does it cost?",
      a: "TrueTime (GPS + atomic clocks) exposes time as a bounded interval with uncertainty epsilon (~1-7ms); on commit Spanner does commit-wait, waiting out the uncertainty so transaction timestamps never overlap — external consistency from physical time. The cost is latency on every commit plus cross-region quorum: the canonical PC/EC system. Teams without clock hardware should use HLC instead (CockroachDB, MongoDB): physical time plus a logical counter, causality plus near-wall-clock, constant size, no special hardware."
    },
    {
      topic: "outbox",
      q: "How do you reliably publish an event when you commit a DB change? (dual-write)",
      a: "You can't atomically write a DB and a broker — a crash between them loses or duplicates the event. Transactional outbox: insert the event into an outbox table in the same local DB transaction as the state change, then a relay — ideally CDC reading the WAL (Debezium) — publishes and marks rows sent. That's at-least-once, so consumers dedupe by event ID. Say it plainly: there is no exactly-once on the wire; at-least-once plus idempotent consumers gives effectively-once."
    },
    {
      topic: "conflicts",
      q: "Compare LWW, vector clocks, and CRDTs — when each?",
      a: "LWW keeps the highest timestamp — simple, but it silently drops the losing write and depends on clock sync; use only for caches and tolerant data. Vector clocks detect whether versions are causally ordered or concurrent and surface siblings for application-specific merge (Dynamo's cart — whose 'deleted item resurrects' anomaly is exactly what OR-Sets fix). CRDTs merge deterministically and always converge with no coordination and no data loss — the answer for collaborative editing, chat, counters, presence, active-active multi-region. CRDT costs to earmark: tombstone GC, and no global invariants without consensus."
    },
    {
      topic: "delivery",
      q: "You've got a transaction spanning three services. Talk me through how you'd approach the design out loud.",
      a: "Lead with the decision: Saga over 2PC, because these are independent failure domains and I won't couple their availability with a blocking coordinator — I'd only 2PC a single tightly-coupled stack with a hard atomicity bar. Then earmark the hard part up front: the risk isn't the happy path, it's the compensations and the visible intermediate state. Pick orchestration for traceability, name the idempotency and outbox requirements, and call out the one invariant that worries you (double-charge) and how the pivot step handles it. Decision, trigger, altitude — never a list of options trailing off."
    },
    {
      topic: "YAGNI",
      q: "When would you NOT reach for consensus or strong consistency?",
      a: "Most of the time — and saying so is the senior move. Default to the least coordination that meets the requirement: single-leader DB with async replicas, session guarantees, and idempotency keys covers most real workloads with no consensus on the write path. Reach for consensus only when correctness depends on a single agreed value or order (leader election, locks, membership, a linearizable log), and for strong consistency only where staleness is user-visibly wrong or unsafe. Name what you're deliberately not building and the trigger that would make you build it."
    },
    {
      topic: "multi-region",
      q: "Active-active or active-passive?",
      a: "Wrong first question — extract RTO and RPO first; the topology is arithmetic on those numbers. Then climb the write ladder only as the conflict surface forces you: single-writer with global reads, active-passive with fenced promotion, region-homed active-active (the default — homing each entity to one region makes same-entity conflicts unrepresentable), and true multi-master only for genuinely merge-tolerant state like carts and presence. Conflicts are created by topology, not resolved by it."
    },
    {
      topic: "static stability",
      q: "A region fails — walk me through it.",
      a: "Anycast reconverges users to the next-nearest PoPs in seconds, automatically. Health checks mark the dead region's origins down and static routing tables fail to survivors, which absorb the load because each region ran at 66% or less — the capacity already existed. The dead region's homed entities serve stale reads from replicas or queue writes per a pre-decided posture (money fails closed). The humans show up at minute three to make exactly one pre-scoped decision: promote or wait, with fencing. If someone is doing capacity math at T+30s, it isn't statically stable."
    },
    {
      topic: "multi-region",
      q: "Why so much idle capacity across your regions?",
      a: "It isn't idle — it's the RTO insurance premium. N+1 sizing means each of 3 regions runs at 66% or less so any one region's death is absorbed by capacity that already exists; autoscaling is not a failover plan, because during a region loss it faces a cold-start stampede on the cloud's worst day. The headroom has a dollar figure attached to a written RTO: cut the headroom and you rewrite the RTO and tell the customers."
    }
  ]
};
