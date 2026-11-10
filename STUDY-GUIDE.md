# Study Guide — Distributed Systems in TypeScript

This repo is the runnable half of **Core Course / 02-distributed-systems.md** (plus 02b for multi-region): every phase builds a failure mode or protocol from the module in ~100 lines of commented TypeScript, so you watch the anomaly happen and then watch the fix hold. Study loop: read the module section, run the phase (`npm run phaseN`), read the source top-comment, then close the loop with the Drill panel in the web lab (`npm run web`) until you can deliver each answer as "**\<choice\> because \<one requirement\>; I'd revisit if \<trigger\>**". Run the phases in order — later phases (9–13, capstone) deliberately build on earlier ones.

## Phase → module map

| Phase | What it builds | Module section | The staff insight |
|---|---|---|---|
| 1 `write-skew.ts` | Two txns break "≥1 doctor on call" under Snapshot Isolation; `SERIALIZABLE`/`FOR UPDATE` refuses | 02 §1.2 Isolation Levels & Anomalies | "Snapshot Isolation prevents phantoms but NOT write skew." |
| 2 `cap-partition.ts` | One 5-node cluster behaving CP (reject) vs AP (diverge) across a 3-2 partition | 02 §2 CAP Theorem & PACELC | "The latency-vs-consistency trade-off is paid on every single request, so PACELC's 'else' clause is where 99.9% of the real engineering decisions live." |
| 3 `raft.ts` | Raft from scratch — terms, election, replication; minority leader appends but never commits | 02 §3.2 Raft | "Consensus protocols guarantee we never decide wrong, but cannot guarantee we always decide fast." |
| 4 `fencing.ts` | GC-paused lock holder clobbers state; the resource rejects token 33 < 34 | 02 §3.4–3.5 Split-Brain, Fencing, Locks | "The lock gives me uniqueness and liveness; safety comes from the resource rejecting stale fencing tokens." |
| 5 `2pc-vs-saga.ts` | Kill the 2PC coordinator after PREPARE (in-doubt, locks held) vs clean Saga compensation | 02 §4.1 + §4.3 2PC / Saga | "The risk in a Saga isn't the happy path — it's the compensations and the visible intermediate state." |
| 6 `retry-storm.ts` | A transient dip becomes a metastable outage; budget + jitter + breaker recover | 02 §5.1–5.2 Retries, Circuit Breakers | "The system stays down even after the original trigger is gone, because retry load is now self-sustaining." |
| 7 `crdt.ts` | LWW merge loses a cart item; OR-Set and PN-Counter converge in any order | 02 §6.3 LWW, Vector Clocks, CRDTs | "Convergence is free, but global invariants and tombstone GC are the two things that'll bite." |
| 8 `clocks.ts` | Wall-clock skew inverts causality; Lamport restores order, vector clocks flag concurrency | 02 §7 Clocks | "Never use physical timestamps to determine causal order or for correctness." |
| 9 `session-guarantees.ts` | Read-your-writes and monotonic reads via a per-session LSN token over lagging replicas | 02 §1.5 Eventual & Session Consistency | "Those three session guarantees kill ~90% of the 'where did my update go' UX bugs at near-zero coordination cost." |
| 10 `outbox.ts` | The dual-write bug, transactional outbox + relay, idempotent consumer | 02 §4.4 Idempotency & Outbox | "There is no exactly-once on the wire — at-least-once delivery + idempotent consumers = effectively-once." |
| 11 `hlc.ts` | A hybrid logical clock: causal order + near-real timestamps, constant size | 02 §7 Clocks (HLC) | "For most systems I reach for HLC — it's the pragmatic default; TrueTime only if I own the hardware." |
| 12 `quorum-read-repair.ts` | R+W>N overlap by pigeonhole; read-repair heals; R+W≤N reads stale | 02 §1.6 Quorum (R+W>N) | "Quorum gives overlap; I still need read-repair and a conflict-resolution rule." |
| 13 `bulkheads.ts` | Shared pool vs bulkheads vs shuffle sharding — a poison tenant's blast radius, measured | 02 §5.3 Bulkheads | "Timeouts bound how long you wait, circuit breakers stop hammering the dead, bulkheads contain the blast radius." |
| 14 `durable-execution.ts` | A workflow engine in 60 lines — history, replay, the record gap, non-determinism | Deep Dive 37 §1–3, §6 · Pattern 15 | "The history is the state; replay is recovery. Workflow code decides, steps do, and every step is at-least-once, so every step is idempotent." |
| Capstone `multi-region.ts` | The fiber-cut drill: 66% vs 90% utilization decides whether a region loss is a non-event | 02b §2 write ladder + §4 Static Stability | "Static stability means the failover consumes only decisions and capacity provisioned before the failure." |

## Go deeper

- **[Deep Dives/08-zookeeper.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/08-zookeeper.md)** — the production face of phases 3–4: ephemeral znodes, watches, and zxid as a real fencing token.
- **[Deep Dives/14-pattern-contention.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/14-pattern-contention.md)** — phase 1's write skew and phase 4's locks generalized: who wins when many writers want one row/slot.
- **[Deep Dives/15-pattern-multi-step-processes.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/15-pattern-multi-step-processes.md)** — phase 5 and 10 at design-round scale: sagas, pivots, and workflow engines for multi-step flows.
- **[Deep Dives/37-temporal-durable-execution.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/37-temporal-durable-execution.md)** — what a real engine adds to phase 14: activity timeouts and heartbeats, signals and durable timers, continue-as-new, and versioning for code changes.
- **DDIA ch. 5 (06-replication.md)** — the full replication story behind phases 9 and 12: leaders, lag, quorum edge cases.
- **DDIA ch. 7 (08-transactions.md)** — isolation levels and write skew (phase 1) with the SSI internals the module summarizes.
- **DDIA ch. 9 (10-consistency-and-consensus.md)** — linearizability, causality, and consensus (phases 2, 3, 8, 11) from first principles.
