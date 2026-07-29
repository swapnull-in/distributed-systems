/**
 * Phase 4 — DISTRIBUTED LOCKS & FENCING TOKENS. Run: npm run phase4
 *
 * "Is your distributed lock safe?" is a trap that tests whether you know TIME IS
 * UNRELIABLE. A lock holder can be paused arbitrarily — stop-the-world GC, a
 * hypervisor pause, a network stall — and wake up AFTER its lease expired, still
 * believing it holds the lock. It then writes and corrupts state.
 *
 * A lock alone can NEVER fix this, because the pause happens after the check.
 * Safety must come from the RESOURCE: the lock service hands out a monotonically
 * increasing FENCING TOKEN with each grant, every write carries its token, and
 * the resource REJECTS any write whose token is below the highest it has seen.
 *
 * The split (separate these or you fail the question):
 *   • EFFICIENCY lock (dedupe work) — occasional double-work is fine; plain lock OK.
 *   • CORRECTNESS lock (money, uniqueness) — MUST have fencing at the resource.
 *
 * We reproduce the corruption WITHOUT fencing, then show the resource rejecting
 * the paused old holder's stale write WITH fencing.
 */

import { log } from "../lib/log.ts";

/** The protected resource — e.g. a storage service or a DB row. */
class Resource {
  private data = "initial";
  private highestToken = 0;

  /** Without fencing: accepts any write from anyone holding "the lock". */
  writeUnsafe(who: string, value: string) {
    this.data = value;
    log(`      resource accepts write from ${who} → "${value}"  (no token checked)`);
  }

  /** With fencing: rejects a write whose token is stale. */
  writeFenced(who: string, value: string, token: number): boolean {
    if (token < this.highestToken) {
      log(`      resource REJECTS ${who}'s write (token ${token} < highest ${this.highestToken})  ✓ stale write blocked`);
      return false;
    }
    this.highestToken = token;
    this.data = value;
    log(`      resource accepts ${who}'s write with token ${token} → "${value}"`);
    return true;
  }
  get() { return this.data; }
}

class LockService {
  private token = 0;
  /** Grant leadership + a fresh monotonic fencing token. */
  grant(): number { return ++this.token; }
}

function unsafe() {
  log("═══ A) Lock WITHOUT fencing — a paused holder corrupts state ═══");
  const r = new Resource();
  log("   Holder A acquires the lock. Then A stops-the-world (GC pause)...");
  log("   A's lease expires; Holder B acquires the lock and writes:");
  r.writeUnsafe("B", "B's-correct-write");
  log("   ...A WAKES UP, still thinks it holds the lock, and writes:");
  r.writeUnsafe("A", "A's-STALE-write");
  log(`   final value = "${r.get()}"  ❌ A clobbered B — silent corruption`);
  log("");
}

function fenced() {
  log("═══ B) Lock WITH fencing tokens — the resource enforces safety ═══");
  const r = new Resource();
  const lock = new LockService();
  const tokenA = lock.grant(); // A gets token 1
  log(`   Holder A acquires lock, gets fencing token ${tokenA}. Then A GC-pauses...`);
  const tokenB = lock.grant(); // B gets token 2
  log(`   A's lease expires; Holder B acquires lock, gets token ${tokenB}, writes:`);
  r.writeFenced("B", "B's-correct-write", tokenB);
  log("   ...A WAKES UP and tries to write with its OLD token:");
  r.writeFenced("A", "A's-STALE-write", tokenA);
  log(`   final value = "${r.get()}"  ✓ safety came from the resource, not the lock`);
  log("");
}

function main() {
  unsafe();
  fenced();
  log("Say it like this:");
  log("   • 'The lock gives me liveness and uniqueness; the RESOURCE gives me safety by");
  log("      rejecting stale fencing tokens — two different jobs.'");
  log("   • This is Kleppmann's critique of Redlock: no fencing token by default.");
  log("   • YAGNI counterpoint: for deduping a cron job, a plain Redis lock is fine —");
  log("     fencing is for correctness-critical paths (money, uniqueness) only.");
  process.exit(0);
}

main();
