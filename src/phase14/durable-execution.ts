/**
 * Phase 14 — DURABLE EXECUTION: a workflow that survives its own crash.
 * Run: node "src/phase14/durable-execution.ts"
 *
 * A saga (phase5) says WHAT to do when a step fails. It does not say what
 * happens when the process RUNNING the saga dies between steps. Charge the
 * card, crash, restart: does the code charge again? Hand-built answers are a
 * status column, a retry counter and a sweeper for stuck rows — per workflow.
 *
 * Durable execution (Temporal, Cadence, Step Functions' cousin) answers it
 * once, with one idea:
 *
 *   THE EVENT HISTORY IS THE STATE.
 *
 * Every step's result is appended to a per-workflow log BEFORE the workflow
 * moves on. After a crash, a fresh worker runs the SAME workflow function from
 * the top — but each step first looks in the history. If a result is recorded,
 * the step returns it instantly and does NOT run again. Execution fast-forwards
 * to the first step with no recorded result, and real work resumes there.
 * This is event sourcing (and Flink's checkpoint-and-replay) applied to
 * control flow.
 *
 * Two rules pay for that trick:
 *
 *   • WORKFLOW CODE MUST BE DETERMINISTIC — on replay it must ask for the same
 *     steps in the same order, or the history no longer lines up. No clock, no
 *     random, no I/O in workflow code; all of that lives in steps ("activities").
 *     Changing the code while executions are in flight is the same hazard, which
 *     is why real engines have version markers.
 *
 *   • STEPS ARE AT-LEAST-ONCE — a worker can finish a side effect and die
 *     before the result is recorded. The step WILL run again. So every step
 *     carries an idempotency key derived from (workflowId, step name) — stable
 *     across attempts — and the downstream system dedupes on it.
 *
 * We demo: (A) a naive workflow that crashes after charging and double-charges
 * on restart; (B) the same crash under durable execution — replay skips the
 * recorded charge; (C) the nastier crash, AFTER the side effect but BEFORE the
 * record — only the idempotency key saves you; (D) a code change that makes
 * replay diverge, caught as a non-determinism error.
 *
 * TAKEAWAY: record every step's result, replay from the top, and recovery is
 * just "run it again". Workflow code decides, steps do; steps are at-least-once,
 * so steps are idempotent. Reach for an engine when flows are long-lived and
 * many — for two steps in one database, a transaction + outbox (phase10) wins.
 */

import { log } from "../lib/log.ts";

// ── The outside world: a payment provider that dedupes on an idempotency key ──

class PaymentProvider {
  charges: Array<{ key: string; amount: number }> = [];
  private readonly seen = new Map<string, string>();

  /** Charge a card. With a key, a repeat returns the original receipt instead of charging again. */
  charge(amount: number, idempotencyKey?: string): string {
    if (idempotencyKey && this.seen.has(idempotencyKey)) return this.seen.get(idempotencyKey)!;
    const receipt = `rcpt_${this.charges.length + 1}`;
    this.charges.push({ key: idempotencyKey ?? "(none)", amount });
    if (idempotencyKey) this.seen.set(idempotencyKey, receipt);
    return receipt;
  }
}

class Crash extends Error {}

// ── The engine: an append-only history per workflow, and replay ───────────────

interface HistoryEvent {
  step: string;      // the step's name — replay checks it matches what the code asks for
  result: unknown;
}

/** Where a crash should be injected, for the demos. */
type CrashPoint = { step: string; when: "before-record" | "after-record" } | null;

class Engine {
  /** Durable storage: survives worker crashes. In Temporal this is the event history. */
  readonly histories = new Map<string, HistoryEvent[]>();

  /**
   * Run a workflow function to completion or until it crashes. Calling this
   * again with the same workflowId IS the recovery path: it replays.
   */
  run<T>(workflowId: string, workflow: (ctx: Context) => T, crashAt: CrashPoint = null): T {
    const history = this.histories.get(workflowId) ?? [];
    this.histories.set(workflowId, history);
    return workflow(new Context(workflowId, history, crashAt));
  }
}

class Context {
  private cursor = 0;          // how far through the history this execution has replayed
  replayed = 0;
  executed = 0;
  readonly workflowId: string;
  private readonly history: HistoryEvent[];
  private readonly crashAt: CrashPoint;

  constructor(workflowId: string, history: HistoryEvent[], crashAt: CrashPoint) {
    this.workflowId = workflowId;
    this.history = history;
    this.crashAt = crashAt;
  }

  /** Stable across retries and replays — never includes an attempt number. */
  idempotencyKey(step: string): string {
    return `${this.workflowId}:${step}`;
  }

  /**
   * Run a side-effecting step exactly as the workflow asks — unless the history
   * already holds its result, in which case return that and skip the effect.
   */
  step<T>(name: string, effect: (idempotencyKey: string) => T): T {
    const recorded = this.history[this.cursor];
    if (recorded) {
      if (recorded.step !== name) {
        throw new Error(`non-determinism: history has step "${recorded.step}" at position ${this.cursor}, code asked for "${name}"`);
      }
      this.cursor++;
      this.replayed++;
      return recorded.result as T;
    }
    const result = effect(this.idempotencyKey(name));
    this.executed++;
    if (this.crashAt?.step === name && this.crashAt.when === "before-record") throw new Crash(`worker died after "${name}" ran but before its result was recorded`);
    this.history.push({ step: name, result });
    this.cursor++;
    if (this.crashAt?.step === name && this.crashAt.when === "after-record") throw new Crash(`worker died right after recording "${name}"`);
    return result;
  }
}

// ── The workflow: charge → reserve → ship ────────────────────────────────────

function orderWorkflow(provider: PaymentProvider, useKey: boolean) {
  return (ctx: Context): string => {
    const receipt = ctx.step("charge", (key) => provider.charge(4999, useKey ? key : undefined));
    const reservation = ctx.step("reserve", () => "resv_1");
    const shipment = ctx.step("ship", () => "ship_1");
    return `done (${receipt}, ${reservation}, ${shipment}) — replayed ${ctx.replayed} steps, executed ${ctx.executed}`;
  };
}

/** Run until done, restarting after each crash the way a worker fleet would. */
function runWithRestarts<T>(engine: Engine, id: string, workflow: (ctx: Context) => T, firstCrash: CrashPoint): T {
  try {
    return engine.run(id, workflow, firstCrash);
  } catch (err) {
    if (!(err instanceof Crash)) throw err;
    log(`   💥 ${err.message}`);
    log("   ↻ a new worker picks the workflow up and runs it from the top");
    return engine.run(id, workflow);
  }
}

// ── (A) Naive: no history, so a restart repeats everything ───────────────────

log("(A) NAIVE — the process keeps its progress in memory");
{
  const provider = new PaymentProvider();
  const naive = () => {
    provider.charge(4999);
    throw new Crash("worker died after charging, before reserving");
  };
  try { naive(); } catch (err) { log(`   💥 ${(err as Error).message}`); }
  log("   ↻ restart: nothing remembers the charge, so the code charges again");
  provider.charge(4999);
  log(`   charges at the provider: ${provider.charges.length}  ❌ the customer paid twice`);
}

// ── (B) Durable execution: crash after the result was recorded ───────────────

log("");
log("(B) DURABLE EXECUTION — crash after the charge was recorded in the history");
{
  const engine = new Engine();
  const provider = new PaymentProvider();
  const outcome = runWithRestarts(engine, "order-1001", orderWorkflow(provider, false), { step: "charge", when: "after-record" });
  log(`   ${outcome}`);
  log(`   charges at the provider: ${provider.charges.length}  ✅ replay returned the recorded receipt instead of charging`);
  log(`   history: ${engine.histories.get("order-1001")!.map((e) => e.step).join(" → ")}`);
}

// ── (C) The gap: side effect done, result not yet recorded ───────────────────

log("");
log("(C) THE GAP — crash after the charge happened but BEFORE it was recorded");
for (const useKey of [false, true]) {
  const engine = new Engine();
  const provider = new PaymentProvider();
  log(`   step ${useKey ? "WITH" : "WITHOUT"} an idempotency key:`);
  runWithRestarts(engine, "order-1002", orderWorkflow(provider, useKey), { step: "charge", when: "before-record" });
  const verdict = provider.charges.length === 1 ? "✅ the provider deduped the retry" : "❌ the step ran twice and charged twice";
  log(`   charges at the provider: ${provider.charges.length}  ${verdict}`);
  if (useKey) log(`   key used both times: "${provider.charges[0]!.key}" — derived from workflow id + step, never the attempt`);
}

// ── (D) Non-determinism: the code changed under a running workflow ───────────

log("");
log("(D) CODE CHANGE MID-FLIGHT — a new version inserts a fraud check before the charge");
{
  const engine = new Engine();
  const provider = new PaymentProvider();
  try { engine.run("order-1003", orderWorkflow(provider, true), { step: "charge", when: "after-record" }); } catch { /* crashed mid-flight, as planned */ }
  const v2 = (ctx: Context): string => {
    ctx.step("fraud-check", () => "clear");          // new first step
    ctx.step("charge", (key) => provider.charge(4999, key));
    return "done";
  };
  try {
    engine.run("order-1003", v2);
  } catch (err) {
    log(`   ❌ ${(err as Error).message}`);
  }
  log("   the old history cannot be replayed by the new code. Real engines gate the new branch behind a");
  log("   version marker (old runs keep the old path) or pin old runs to old workers until they finish.");
}

log("");
log("TAKEAWAY: the history is the state; replay is recovery. Workflow code decides, steps do — and steps are idempotent.");
