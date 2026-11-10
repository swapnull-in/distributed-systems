# Learn Distributed Systems in TypeScript

A hands-on, runnable project for understanding distributed systems at a Staff/EM
level — build the failure modes and protocols that interviews (and 3am pages)
actually turn on, **from scratch**, with no external services.

Every phase is a small script you can run and read. No build step, no database,
no broker: modern Node runs the TypeScript directly and the whole cluster is
simulated in-process, so **you** control the partitions, the clock skew, and the
GC pause.

> Built to match a Staff-level study path. The through-line: every distributed
> question is **levers attached to a requirement, chosen decisively** —
> consistency model · CAP/PACELC posture · consensus (only when you need one
> agreed order) · distributed transactions · fault tolerance · conflict
> resolution + clocks · multi-region topology. The one delivery rule:
> **"<choice> because <one requirement>; I'd revisit if <trigger>"** — never "it depends."

## Prerequisites

- **Node.js 22+** (uses native `.ts` execution). No external services needed.

## Setup

```bash
npm install   # only dev types; nothing to download to run the demos
```

## The lessons

Run in order. Each prints a timestamped log so you can watch the anomaly happen,
then watch the fix hold.

| Command | What you learn | Maps to |
|---|---|---|
| `npm run phase1` | **Write skew** — why Snapshot Isolation / Postgres REPEATABLE READ allows it, and the fix | consistency model |
| `npm run phase2` | **CAP under partition** — the same cluster as CP (reject) vs AP (diverge); PACELC | CAP/PACELC |
| `npm run phase3` | **Raft** from scratch — terms, election, log replication, split-brain made impossible | consensus |
| `npm run phase4` | **Fencing tokens** — why a distributed lock is unsafe alone, and how the *resource* makes it safe | locks/safety |
| `npm run phase5` | **2PC vs Saga** — kill the coordinator mid-commit (in-doubt) vs clean compensation | distributed txns |
| `npm run phase6` | **Retry storm** — a transient dip becomes a *metastable* outage; budget + jitter + breaker | fault tolerance |
| `npm run phase7` | **CRDTs vs LWW** — LWW silently drops a write; OR-Set / PN-Counter converge | conflict resolution |
| `npm run phase8` | **Clocks** — wall-clock skew inverts causality; Lamport + vector clocks fix it | clocks/ordering |
| `npm run phase9`  | **Session guarantees** — read-your-writes & monotonic reads via a per-session LSN token | consistency model |
| `npm run phase10` | **Outbox** — the dual-write bug, transactional outbox, idempotency (effectively-once) | distributed txns |
| `npm run phase11` | **HLC** — a hybrid logical clock: causal order + near-real timestamps, constant size | clocks/ordering |
| `npm run phase12` | **Quorum** — R+W>N overlap and read-repair; when R+W≤N reads stale | consistency / CAP |
| `npm run phase13` | **Bulkheads** — bulkheads & shuffle sharding shrink the blast radius | fault tolerance |
| `npm run phase14` | **Durable execution** — the event history is the state: replay after a crash, at-least-once steps with idempotency keys, non-determinism on a code change *(Deep Dive 37)* | workflows |
| `npm run phase15` | **Mutual match** — two parties must both agree exactly once: write-then-check misses or duplicates, one row per unordered pair fixes it *(Core 54)* | contention |
| `npm run capstone` | **Multi-region & static stability** — the fiber-cut drill with the capacity math | multi-region (L6) |

Start by reading `src/phase1/write-skew.ts` and `src/phase3/raft.ts` — the whole
protocols in a few dozen commented lines each.

## Interactive Failure Lab

Every phase is also a live instrument in the browser — cut a Raft cluster and watch
which side commits, kill a 2PC coordinator, drag the utilization until a region loss
flips from non-event to outage, merge two replicas under LWW vs a CRDT, and more.

```bash
npm run web        # serves web/index.html at http://localhost:8080 (no deps)
```

It's one self-contained static page (with self-hosted fonts) grouped by the seven
levers, keyboard-navigable and deep-linkable. To host it on **Cloudflare Pages**:
connect this repo in the dashboard with build output `web` (auto-deploys on push),
or run `npx wrangler login` then `npm run deploy`.

## What each phase proves (the money quotes)

- **Phase 1** — two on-call doctors both go off-shift under Snapshot Isolation
  because each read the *same snapshot* and wrote a *different row*; `0` doctors on
  call. `SERIALIZABLE` / `FOR UPDATE` makes the second refuse.
- **Phase 3** — partition the Raft leader into a 2-node minority: it can **append
  but never commit**; the 3-node majority elects a new leader at a higher term; on
  heal the old leader's uncommitted write is **overwritten**. Safety never breaks.
- **Phase 4** — without fencing, a GC-paused holder wakes up and **clobbers** the
  new holder's write; with a fencing token the resource **rejects** it (token 33 < 34).
- **Phase 5** — kill the 2PC coordinator after PREPARE and both participants hang
  **in-doubt with locks held**; the same flow as a Saga **compensates** cleanly.
- **Phase 6** — a capacity dip in rounds 3–5: the naive retrier stays **collapsed
  even after capacity recovers** (retries *became* the load — metastable); the
  budgeted + circuit-broken path **recovers to baseline**.
- **Phase 7** — a cart merge under LWW **loses an item**; the OR-Set keeps both,
  and a PN-Counter converges to the same total **in any merge order**.
- **Phase 8** — a lower wall-clock timestamp on the *later* event makes LWW pick
  the **wrong winner**; Lamport restores the order, vector clocks flag the truly
  **concurrent** pair instead of silently merging it.
- **Capstone** — at **66%** utilization a region loss is a non-event (survivor
  peak stays under 100% — capacity was already there); at **90%** the same cut
  **overloads the survivors**. That gap is the RTO insurance premium, with a number.

## The seven levers, mapped to phases

| Lever | Where |
|---|---|
| Consistency model (per dataset) | Phases 1, 2 |
| CAP / PACELC posture | Phase 2 |
| Consensus (only when needed) | Phases 3, 4 |
| Distributed transactions | Phase 5 |
| Fault tolerance | Phase 6 |
| Conflict resolution + clocks | Phases 7, 8 |
| Multi-region + static stability | Capstone |

## Project layout

```
src/
  lib/log.ts                 shared timestamped logger
  phase1/  write skew under snapshot isolation + the fix
  phase2/  CAP: CP-reject vs AP-diverge under a partition
  phase3/  Raft — election, replication, split-brain
  phase4/  fencing tokens (safe distributed locks)
  phase5/  2PC (coordinator dies, in-doubt) vs Saga
  phase6/  retry storm + metastable failure + the three fixes
  phase7/  CRDTs (OR-Set, PN-Counter) vs LWW data loss
  phase8/  clocks — wall-clock skew, Lamport, vector
  phase9/  session guarantees — read-your-writes, monotonic reads
  phase10/ dual-write bug, transactional outbox, idempotency
  phase11/ hybrid logical clock (HLC)
  phase12/ quorum reads — R+W>N + read-repair
  phase13/ bulkheads & shuffle sharding (blast radius)
  phase14/ durable execution (history + replay, idempotent steps)
  phase15/ mutual match (one row per unordered pair)
  capstone/ multi-region static-stability fiber-cut drill
web/
  index.html  ·  serve.mjs   (the interactive Failure Lab — npm run web)
```

## Drill & study guide

The web lab has a **Drill** tab — the matching study module's interview questions
and cheat-sheet one-liners as click-to-reveal cards (active recall: answer out
loud before revealing). [`STUDY-GUIDE.md`](STUDY-GUIDE.md) maps every phase to
the exact module section it implements, with the staff-level insight quoted, and
points to the deep dives to read next.

## License

MIT — use it, fork it, learn from it.
