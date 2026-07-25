import {FullAdapter, RebalanceRejected, rationaleHash} from "../chain/adapter";
import {BPS_DENOMINATOR, TICK_INTERVAL_MS} from "../chain/constants";
import {Allocation} from "./allocations";
import {Bandit, BanditOptions} from "./bandit";
import {BaselineAgent} from "./baseline";

/**
 * The agent service: read state, decide, act, score.
 *
 * ## The ordering trap
 *
 * `LeashVault.rebalance` settles the period's return under the **outgoing** weights
 * and only then applies the new ones — because the outgoing allocation is the one
 * that was actually exposed to the market. So the value change observed across a
 * rebalance is the reward for the *previous* tick's arm, not the one just submitted.
 *
 * Crediting it to the arm just chosen would be a silent, plausible-looking bug: the
 * bandit would still converge on something, the chart would still separate, and the
 * numbers would be meaningless. `pendingArm` below is what keeps the credit attached
 * to the action that earned it.
 *
 * ## Nonce strategy
 *
 * One transaction per tick, and the adapter awaits each receipt before returning, so
 * the wallet is serialised and `nonce too low` cannot happen. At ~300ms blocks the
 * wait fits inside the 3s tick budget with room to spare. This is the single most
 * common way to kill a live agent demo, and it is handled at the adapter, not here.
 */

export interface TickRecord {
  /** Wall clock milliseconds, for the x-axis. */
  readonly at: number;
  readonly epoch: string;
  readonly agentValue: number;
  readonly baselineValue: number;
  readonly weights: readonly number[];
  readonly ratesBps: readonly number[];
  /** Realised return credited this tick, in bps. Null on the first tick. */
  readonly realisedBps: number | null;
  readonly reason: "sweep" | "explore" | "exploit";
  readonly rationale: string;
  readonly txHash: string | null;
  readonly gasUsed: string | null;
  readonly halted: boolean;
  readonly error: string | null;
}

export interface LoopOptions extends BanditOptions {
  /** Milliseconds between ticks. Must stay strictly above the on-chain cooldown. */
  intervalMs?: number;
  /** How many ticks the dashboard keeps. ~10 minutes at a 3s tick. */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 200;

export class AgentLoop {
  readonly bandit: Bandit;

  private readonly adapter: FullAdapter;
  private readonly intervalMs: number;
  private readonly historyLimit: number;

  private baseline: BaselineAgent | null = null;
  private history: TickRecord[] = [];

  /** The arm whose reward has not landed yet. See the ordering note above. */
  private pendingArm: string | null = null;
  private lastValue: number | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;
  private lastError: string | null = null;

  constructor(adapter: FullAdapter, options: LoopOptions = {}) {
    this.adapter = adapter;
    this.intervalMs = options.intervalMs ?? TICK_INTERVAL_MS;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.bandit = new Bandit(options);

    if (this.intervalMs <= 0) throw new Error("tick interval must be positive");
  }

  /* ---------------------------------- control -------------------------------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Wipes the learned estimates and the chart without touching the vault.
   *
   * This is the "show me it learning from scratch" button from the demo plan. It
   * deliberately does *not* reset the book — the vault's value is real on-chain state
   * and this process does not get to rewrite it.
   */
  resetLearning(): void {
    this.bandit.reset();
    this.history = [];
    this.pendingArm = null;
  }

  snapshot(): {
    running: boolean;
    history: readonly TickRecord[];
    arms: ReturnType<Bandit["stats"]>;
    resets: number;
    converged: boolean;
    lastError: string | null;
  } {
    return {
      running: this.running,
      history: this.history,
      arms: this.bandit.stats(),
      resets: this.bandit.resetCount,
      converged: this.bandit.hasConverged(),
      lastError: this.lastError,
    };
  }

  /* ----------------------------------- tick ---------------------------------- */

  /**
   * One decision cycle. Public so tests can drive it by hand instead of waiting on
   * a timer, and so the loop stays a pure function of "how often is this called".
   */
  async tick(): Promise<TickRecord> {
    const [epoch, before] = await Promise.all([this.adapter.getEpoch(), this.adapter.getState()]);

    // Start the baseline from whatever the vault is actually holding, so both lines
    // begin at the same number and the race is legible. Held in a local because
    // property narrowing does not survive the awaits below.
    const baseline = (this.baseline ??= new BaselineAgent(toWei(before.totalValue)));

    if (before.halted) {
      this.stop();
      return this.record({
        at: Date.now(),
        epoch: epoch.toString(),
        agentValue: before.totalValue,
        baselineValue: fromWei(baseline.valueWei),
        weights: before.weights,
        ratesBps: before.rates,
        realisedBps: null,
        reason: "exploit",
        rationale: "halted: the drawdown breaker has cut the agent off",
        txHash: null,
        gasUsed: null,
        halted: true,
        error: null,
      });
    }

    const decision = this.bandit.select(this.pendingArm);
    const rationale = this.explain(decision.reason, decision.allocation);

    let txHash: string | null = null;
    let gasUsed: string | null = null;
    let error: string | null = null;

    try {
      const receipt = await this.adapter.rebalance(
        [...decision.allocation.weights],
        rationaleHash(rationale),
      );
      txHash = receipt.txHash;
      gasUsed = receipt.gasUsed.toString();
      this.lastError = null;
    } catch (e) {
      // A rejected rebalance is a real outcome, not a crash: the cooldown may not
      // have elapsed, or the breaker may have tripped between the read and the send.
      // Nothing is credited, the arm stays pending, and the next tick tries again.
      error = e instanceof RebalanceRejected ? e.reason : String(e);
      this.lastError = error;
    }

    const after = await this.adapter.getState();

    // Credit the *previous* arm with what the settlement just paid. See the ordering
    // note at the top of this file.
    let realisedBps: number | null = null;
    if (txHash !== null && this.lastValue !== null && this.lastValue > 0 && this.pendingArm) {
      realisedBps = ((after.totalValue - this.lastValue) / this.lastValue) * BPS_DENOMINATOR;
      this.bandit.observe(epoch, this.pendingArm, realisedBps);
    }

    if (txHash !== null) {
      this.pendingArm = decision.allocation.id;
      this.lastValue = after.totalValue;
      // Settle the baseline against the same rates the vault just used, so the only
      // difference between the two books is the allocation policy.
      if (before.rates.length > 0) baseline.settle(before.rates);
    }

    // The breaker tripping on this very tick is the demo's drawdown moment. Stop
    // immediately rather than spending a tick discovering it again next time round.
    if (after.halted) this.stop();

    return this.record({
      at: Date.now(),
      epoch: epoch.toString(),
      agentValue: after.totalValue,
      baselineValue: fromWei(baseline.valueWei),
      weights: after.weights,
      ratesBps: before.rates,
      realisedBps,
      reason: decision.reason,
      rationale,
      txHash,
      gasUsed,
      halted: after.halted,
      error,
    });
  }

  /* --------------------------------- internals ------------------------------- */

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.runOnce(), delayMs);
  }

  private async runOnce(): Promise<void> {
    if (this.ticking) return this.schedule(this.intervalMs);
    this.ticking = true;
    try {
      await this.tick();
    } catch (e) {
      // Never let one bad tick kill the loop; an RPC blip should cost a tick, not
      // the demo. The error surfaces in the snapshot the dashboard polls.
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.ticking = false;
      this.schedule(this.intervalMs);
    }
  }

  /**
   * The agent's stated reason for a decision, in one line. Only its hash goes
   * on-chain; this text is what makes the hash mean something to a human holding it.
   */
  private explain(reason: TickRecord["reason"], allocation: Allocation): string {
    const [best] = allocation.id.split(">");
    switch (reason) {
      case "sweep":
        return `sweeping untried allocation ${allocation.id}`;
      case "explore":
        return `exploring ${allocation.id} instead of the current best`;
      case "exploit": {
        const stat = this.bandit.stats().find((s) => s.id === allocation.id);
        const mean = stat?.meanRewardBps;
        const detail = mean === null || mean === undefined ? "no reading" : `${mean.toFixed(1)} bps`;
        return `exploiting ${allocation.id}: ${best} leads at ${detail} over ${stat?.pulls ?? 0} pulls`;
      }
    }
  }

  private record(tick: TickRecord): TickRecord {
    this.history = [...this.history, tick].slice(-this.historyLimit);
    return tick;
  }
}

/** The seam hands value over as whole MON; the baseline books in wei to match the vault. */
function toWei(mon: number): bigint {
  return BigInt(Math.round(mon * 1e18));
}

function fromWei(wei: bigint): number {
  return Number(wei) / 1e18;
}
