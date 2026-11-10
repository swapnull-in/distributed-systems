/**
 * Phase 15 — THE MUTUAL MATCH: two parties must both agree, exactly once.
 * Run: node "src/phase15/mutual-match.ts"
 *
 * Tinder's core rule: when Alice likes Bob AND Bob likes Alice, create ONE
 * match and notify both. It looks like a lookup. It is a race, and the same
 * race shows up anywhere two independent parties must both say yes — a
 * two-sided handshake, a contract both sides sign, a rematch both players accept.
 *
 * THE OBVIOUS DESIGN stores one row per direction and checks the other side:
 *
 *   on like(a → b):   write (a → b)
 *                     if (b → a) exists: create match
 *
 * Two independent writes plus a read cannot decide a two-party agreement,
 * because THE READ RACES THE OTHER PARTY'S WRITE. Two interleavings break it:
 *
 *   • BOTH MISS — each side's check runs before the other's write is visible
 *     (the writes go to different rows, maybe different partitions or a lagging
 *     replica). Both see "no like yet". Two people who liked each other get
 *     NO MATCH, and nothing will ever notice.
 *   • BOTH HIT — each write lands before the other side's check. Both see the
 *     other's like and both create a match: a DUPLICATE, two notifications.
 *
 * THE FIX is to make the agreement ONE ROW that both writes touch:
 *
 *   key = (lo = min(a, b), hi = max(a, b))        the unordered pair
 *   row = { loLikesHi, hiLikesLo, matchedAt }
 *
 * Each like is one atomic update of that row which sets its own flag and
 * returns the other. The storage engine serializes the two updates, so
 * whichever runs second SEES the first — there is no window where both miss.
 * And match creation is itself conditional (set matchedAt only if it is
 * still null), so even a retried request creates the match exactly once.
 *
 * This is phase1's lesson (write skew: two transactions read the same facts
 * and write different rows) and phase4's (make the storage layer the judge)
 * applied to a product feature. The match event leaves through an outbox
 * (phase10) so "match recorded" and "match announced" cannot diverge.
 *
 * We demo: every interleaving of the two likes, exhaustively, under both
 * designs — counting how many produce exactly one match.
 *
 * TAKEAWAY: when two parties must both agree, put both decisions in one row
 * keyed by the unordered pair and update it atomically. The conditional
 * update that completes the pair is the single creator of the match.
 */

import { log } from "../lib/log.ts";

// ── Design 1: one row per direction, write then check ────────────────────────

/** The four steps of the naive flow. Each user does W (write own like) then C (check the other's). */
type Step = "A.write" | "A.check" | "B.write" | "B.check";

function runDirectional(order: Step[]): number {
  const likes = new Set<string>();           // "alice→bob", "bob→alice"
  let matches = 0;
  for (const step of order) {
    if (step === "A.write") likes.add("alice→bob");
    if (step === "B.write") likes.add("bob→alice");
    if (step === "A.check" && likes.has("bob→alice")) matches++;
    if (step === "B.check" && likes.has("alice→bob")) matches++;
  }
  return matches;
}

/**
 * The same flow when the check reads a replica that hasn't applied the other
 * side's write yet — the realistic "both miss" case.
 */
function runDirectionalStaleRead(): number {
  const primary = new Set<string>();
  const replica = new Set<string>();         // lags the primary
  let matches = 0;
  primary.add("alice→bob");                  // A.write
  primary.add("bob→alice");                  // B.write
  if (replica.has("bob→alice")) matches++;   // A.check on the replica: not there yet
  if (replica.has("alice→bob")) matches++;   // B.check on the replica: not there yet
  for (const like of primary) replica.add(like); // replication catches up — too late, nobody re-checks
  return matches;
}

// ── Design 2: one row per unordered pair, atomic update ──────────────────────

interface PairRow {
  loLikesHi: boolean;
  hiLikesLo: boolean;
  matchedAt: number | null;
}

class PairStore {
  private readonly rows = new Map<string, PairRow>();
  matchEvents = 0;                           // what the outbox would publish

  /**
   * One like = one atomic update on the pair's row. Sets the caller's flag,
   * and if that completes the pair, sets matchedAt — only if it is still null.
   */
  like(from: string, to: string, now: number): "liked" | "matched" | "already-matched" {
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const key = `${lo}|${hi}`;
    const row = this.rows.get(key) ?? { loLikesHi: false, hiLikesLo: false, matchedAt: null };
    if (from === lo) row.loLikesHi = true; else row.hiLikesLo = true;
    let result: "liked" | "matched" | "already-matched" = "liked";
    if (row.loLikesHi && row.hiLikesLo) {
      if (row.matchedAt === null) { row.matchedAt = now; this.matchEvents++; result = "matched"; }
      else result = "already-matched";
    }
    this.rows.set(key, row);
    return result;
  }
}

/** With one row there are only two orders the engine can pick, plus retries of either like. */
function runPair(order: Array<"A" | "B">): number {
  const store = new PairStore();
  let t = 0;
  for (const who of order) who === "A" ? store.like("alice", "bob", ++t) : store.like("bob", "alice", ++t);
  return store.matchEvents;
}

// ── Enumerate every interleaving ─────────────────────────────────────────────

/** All orderings of the four steps where each user's write precedes their own check. */
function interleavings(): Step[][] {
  const out: Step[][] = [];
  const walk = (prefix: Step[], a: number, b: number) => {
    if (a === 2 && b === 2) { out.push(prefix); return; }
    if (a < 2) walk([...prefix, a === 0 ? "A.write" : "A.check"], a + 1, b);
    if (b < 2) walk([...prefix, b === 0 ? "B.write" : "B.check"], a, b + 1);
  };
  walk([], 0, 0);
  return out;
}

log("(A) ONE ROW PER DIRECTION — every interleaving of write-then-check for two users");
{
  const tally = new Map<number, number>();
  for (const order of interleavings()) {
    const m = runDirectional(order);
    tally.set(m, (tally.get(m) ?? 0) + 1);
    const verdict = m === 1 ? "✅ one match" : m === 0 ? "❌ NO match" : "❌ DUPLICATE match";
    log(`   ${order.join(" → ").padEnd(46)} matches=${m}  ${verdict}`);
  }
  const total = interleavings().length;
  log(`   exactly one match in ${tally.get(1) ?? 0} of ${total} interleavings; duplicates in ${tally.get(2) ?? 0}`);
}

log("");
log("(B) SAME DESIGN, CHECK READS A LAGGING REPLICA — the 'both miss' case");
{
  const m = runDirectionalStaleRead();
  log(`   both likes are committed on the primary, both checks ran on a replica that had neither: matches=${m}`);
  log("   ❌ two people who liked each other never match, and no later event re-runs the check");
}

log("");
log("(C) ONE ROW PER PAIR — the engine serializes the two updates; try both orders and retries");
{
  const cases: Array<[string, Array<"A" | "B">]> = [
    ["Alice then Bob", ["A", "B"]],
    ["Bob then Alice", ["B", "A"]],
    ["Alice, Bob, Alice retries", ["A", "B", "A"]],
    ["Bob, Alice, both retry", ["B", "A", "B", "A"]],
    ["Alice alone, twice", ["A", "A"]],
  ];
  for (const [name, order] of cases) {
    const m = runPair(order);
    const expected = order.includes("A") && order.includes("B") ? 1 : 0;
    log(`   ${name.padEnd(28)} match events=${m}  ${m === expected ? "✅" : "❌"}`);
  }
  log("   whichever update runs second sees the first one's flag, and matchedAt IS NULL admits one creator");
}

log("");
log("TAKEAWAY: a two-party agreement is one row keyed by the unordered pair, updated atomically, with a conditional create.");
