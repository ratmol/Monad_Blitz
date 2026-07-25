import {encodeAbiParameters, formatEther, keccak256, parseEther} from "viem";

import {
  ChainStats,
  FullAdapter,
  RebalanceReceipt,
  RebalanceRejected,
  VaultState,
} from "./adapter";
import {
  BPS_DENOMINATOR,
  MAX_ABS_RATE_BPS,
  MAX_DRAWDOWN_BPS,
  MAX_WEIGHT_BPS,
  MONAD_BLOCK_TIME_MS,
  RATE_EPOCH_BLOCKS,
  REBALANCE_COOLDOWN_SECONDS,
  STRATEGY_COUNT,
} from "./constants";

/**
 * A faithful in-memory reimplementation of LeashVault.
 *
 * This is not a stub that returns plausible numbers. It reproduces the contract's
 * arithmetic exactly — same epoch-keyed rate derivation, same integer truncation,
 * same settlement order, same cap, cooldown, and breaker rules — so the bandit and
 * dashboard behave identically whether or not a chain is attached. Anything that
 * works here and fails against Monad is an infrastructure problem, not a logic one.
 *
 * The virtual chain advances at Monad's block time, which is what moves the epoch
 * and therefore the market. Value only moves when the agent acts, exactly as
 * on-chain: settlement happens inside `rebalance`, never in a view.
 */

/** Measured from the Foundry gas report for `rebalance()`. The mock cannot know a
 *  real number; only the real adapter reports gas from actual receipts, and the
 *  dashboard's Monad-vs-Ethereum counter must be fed from that one. */
const MOCK_GAS_PER_REBALANCE = 94_702n;

export interface MockAdapterOptions {
  /** Starting book value. Defaults to 100 MON, matching the contract tests. */
  principal?: bigint;
  /** Virtual block height at construction. */
  startBlock?: bigint;
  /** Injectable clock in milliseconds. Supply a fake one to make tests deterministic. */
  now?: () => number;
  /** Virtual block time. Defaults to Monad's ~300ms. */
  blockTimeMs?: number;
}

export class MockAdapter implements FullAdapter {
  readonly isMock = true;

  private readonly now: () => number;
  private readonly blockTimeMs: number;
  private readonly startBlock: bigint;
  private readonly startedAtMs: number;

  private weights: bigint[];
  private bookValue: bigint;
  private highWaterMark: bigint;
  private lastRebalanceAt = 0n;
  private halted = false;

  private txCount = 0;
  private totalGas = 0n;

  constructor(options: MockAdapterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.blockTimeMs = options.blockTimeMs ?? MONAD_BLOCK_TIME_MS;
    this.startBlock = options.startBlock ?? 0n;
    this.startedAtMs = this.now();

    this.bookValue = options.principal ?? parseEther("100");
    this.highWaterMark = this.bookValue;

    // Even split, with the last strategy absorbing the remainder so the sum is
    // exact. Mirrors the contract's constructor.
    const even = BigInt(Math.floor(BPS_DENOMINATOR / STRATEGY_COUNT));
    this.weights = Array.from({length: STRATEGY_COUNT}, () => even);
    this.weights[STRATEGY_COUNT - 1] = BigInt(BPS_DENOMINATOR) - even * BigInt(STRATEGY_COUNT - 1);
  }

  /* ------------------------------- ChainAdapter ------------------------------ */

  async getState(): Promise<VaultState> {
    return {
      weights: this.weights.map(Number),
      totalValue: Number(formatEther(this.bookValue)),
      halted: this.halted,
      rates: this.strategyRates().map(Number),
    };
  }

  async rebalance(weights: number[], rationaleHash: string): Promise<RebalanceReceipt> {
    if (this.halted) throw new RebalanceRejected("vault halted");

    const timestamp = this.timestampSeconds();
    if (this.lastRebalanceAt !== 0n) {
      const elapsed = timestamp - this.lastRebalanceAt;
      if (elapsed < BigInt(REBALANCE_COOLDOWN_SECONDS)) {
        const left = REBALANCE_COOLDOWN_SECONDS - Number(elapsed);
        throw new RebalanceRejected(`cooldown active, ${left}s left`);
      }
    }

    const next = this.validate(weights);

    this.lastRebalanceAt = timestamp;
    this.settle();

    this.txCount += 1;
    this.totalGas += MOCK_GAS_PER_REBALANCE;

    const receipt: RebalanceReceipt = {
      // Deterministic and hash-shaped, but not a real transaction. `isMock` is how
      // the dashboard knows to suppress the explorer link rather than serve a 404.
      txHash: keccak256(
        encodeAbiParameters(
          [{type: "uint256"}, {type: "bytes32"}],
          [BigInt(this.txCount), rationaleHash as `0x${string}`],
        ),
      ),
      gasUsed: MOCK_GAS_PER_REBALANCE,
    };

    // The contract lets this call succeed and simply declines to apply the new
    // allocation once the breaker trips; every later rebalance reverts instead.
    if (this.tripBreakerIfDrawn()) return receipt;

    this.weights = next;
    return receipt;
  }

  async getStats(): Promise<ChainStats> {
    return {txCount: this.txCount, totalGas: this.totalGas};
  }

  /* ------------------------------ ChainDiagnostics --------------------------- */

  async getAgentBalance(): Promise<bigint> {
    // A mock wallet never drains. The real adapter is where a low balance matters.
    return parseEther("100");
  }

  getAgentAddress(): string {
    return "0x0000000000000000000000000000000000000A6E";
  }

  getVaultAddress(): string {
    return "0x000000000000000000000000000000000000AEA5";
  }

  /* -------------------------- Owner-side, for the demo ----------------------- */

  deposit(amount: bigint): void {
    this.resizeBook(this.bookValue + amount);
  }

  withdraw(amount: bigint): void {
    if (amount > this.bookValue) throw new Error("amount exceeds book value");
    this.resizeBook(this.bookValue - amount);
  }

  /* -------------------------------- Test hooks ------------------------------- */

  /** Current virtual block height. Exposed so tests can assert the epoch directly. */
  blockNumber(): bigint {
    const elapsedMs = this.now() - this.startedAtMs;
    return this.startBlock + BigInt(Math.floor(elapsedMs / this.blockTimeMs));
  }

  /** Book value in wei, unrounded. `getState` narrows this to a float for charting. */
  bookValueWei(): bigint {
    return this.bookValue;
  }

  /** Drawdown from the high water mark in bps. Zero at a new high. */
  drawdownBps(): bigint {
    if (this.highWaterMark === 0n || this.bookValue >= this.highWaterMark) return 0n;
    return ((this.highWaterMark - this.bookValue) * BigInt(BPS_DENOMINATOR)) / this.highWaterMark;
  }

  /**
   * `keccak256(abi.encode(epoch, strategyId)) % 401 - 200`, byte-identical to
   * `LeashVault.rateAtEpoch`. Verified against the contract in the unit tests.
   */
  rateAtEpoch(epoch: bigint, strategyId: number): bigint {
    const seed = BigInt(
      keccak256(
        encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [epoch, BigInt(strategyId)]),
      ),
    );
    const span = 2n * MAX_ABS_RATE_BPS + 1n;
    return (seed % span) - MAX_ABS_RATE_BPS;
  }

  strategyRateBps(strategyId: number, atBlock = this.blockNumber()): bigint {
    return this.rateAtEpoch(atBlock / RATE_EPOCH_BLOCKS, strategyId);
  }

  /* --------------------------------- Internals ------------------------------- */

  private timestampSeconds(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  private strategyRates(): bigint[] {
    const at = this.blockNumber();
    return Array.from({length: STRATEGY_COUNT}, (_, i) => this.strategyRateBps(i, at));
  }

  private validate(weights: number[]): bigint[] {
    if (weights.length !== STRATEGY_COUNT) {
      throw new RebalanceRejected(`expected ${STRATEGY_COUNT} weights, got ${weights.length}`);
    }

    let sum = 0n;
    const next = weights.map((w, i) => {
      if (!Number.isInteger(w) || w < 0) {
        throw new RebalanceRejected(`weight ${i} is not a non-negative integer: ${w}`);
      }
      if (w > MAX_WEIGHT_BPS) {
        throw new RebalanceRejected(`weight ${i} of ${w} exceeds the ${MAX_WEIGHT_BPS} bps cap`);
      }
      sum += BigInt(w);
      return BigInt(w);
    });

    if (sum !== BigInt(BPS_DENOMINATOR)) {
      throw new RebalanceRejected(`weights sum to ${sum}, expected ${BPS_DENOMINATOR}`);
    }
    return next;
  }

  /**
   * Applies the period's return under the *outgoing* weights, which is the
   * allocation that was actually exposed to it. Mirrors `LeashVault._settle`,
   * including the truncating division.
   */
  private settle(): bigint {
    const bps = BigInt(BPS_DENOMINATOR);
    const rates = this.strategyRates();

    let portfolioRateBps = 0n;
    for (let i = 0; i < STRATEGY_COUNT; i++) {
      portfolioRateBps += this.weights[i] * rates[i];
    }
    portfolioRateBps /= bps;

    this.bookValue += (this.bookValue * portfolioRateBps) / bps;
    if (this.bookValue > this.highWaterMark) this.highWaterMark = this.bookValue;

    return portfolioRateBps;
  }

  private tripBreakerIfDrawn(): boolean {
    if (this.drawdownBps() <= BigInt(MAX_DRAWDOWN_BPS)) return false;
    this.halted = true;
    return true;
  }

  /**
   * Moves the book and scales the high water mark by the same factor, so a deposit
   * or withdrawal leaves the drawdown unchanged. Mirrors `LeashVault._resizeBook`.
   */
  private resizeBook(newTotalValue: bigint): void {
    if (this.bookValue === 0n) {
      this.highWaterMark = newTotalValue;
    } else {
      this.highWaterMark = (this.highWaterMark * newTotalValue) / this.bookValue;
    }
    this.bookValue = newTotalValue;
  }
}
