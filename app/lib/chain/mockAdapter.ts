import {encodeAbiParameters, formatEther, keccak256, parseEther} from "viem";

import {
  ChainStats,
  EpochNotAnchored,
  FullAdapter,
  RebalanceReceipt,
  RebalanceRejected,
  VaultState,
} from "./adapter";
import {
  BLOCKHASH_WINDOW_BLOCKS,
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
 * arithmetic exactly — same anchor-keyed rate derivation, same integer truncation,
 * same settlement order, same cap, cooldown, and breaker rules — so the bandit and
 * dashboard behave identically whether or not a chain is attached. Anything that
 * works here and fails against Monad is an infrastructure problem, not a logic one.
 *
 * The virtual chain advances at Monad's block time, which is what moves the epoch
 * and therefore the market. Value only moves when the agent acts, exactly as
 * on-chain: settlement happens inside `rebalance`, never in a view.
 *
 * The market is unknowable ahead of time here for the same reason it is on-chain:
 * an epoch's rates come from the hash of the block before it began, so no caller —
 * including this test suite — can compute a future epoch's rates. See
 * {@link syntheticBlockHash} for how a mock with no real chain stands that up.
 */

const ZERO_HASH = `0x${"00".repeat(32)}` as const;

/**
 * Stands in for the EVM's `blockhash`. **This is the one place the mock is not the
 * contract.**
 *
 * A mock has no proof-of-work, no parent hashes, nothing to hash a block into. What
 * matters for reproducing LeashVault is not that the value is a real block hash but
 * that it has the two properties the contract's security rests on: it is fixed once
 * the block exists, and it cannot be derived from the epoch number alone by anyone
 * reasoning ahead. A keccak of the height gives the first. The second is enforced
 * by {@link MockAdapter.liveAnchor} refusing to resolve a block that has not been
 * reached yet, exactly as `blockhash` returns zero for a future height.
 *
 * Consequence worth stating plainly: against a real chain the anchor is genuinely
 * unpredictable; here it is merely *withheld*. The mock is for exercising the code
 * paths, never for arguing the market is unriggable. That claim rests on the
 * contract alone.
 */
function syntheticBlockHash(blockNumber: bigint): `0x${string}` {
  return keccak256(encodeAbiParameters([{type: "uint256"}], [blockNumber]));
}

/** Measured from the Foundry gas report for `rebalance()`. The mock cannot know a
 *  real number; only the real adapter reports gas from actual receipts, and the
 *  dashboard's Monad-vs-Ethereum counter must be fed from that one. */
const MOCK_GAS_PER_REBALANCE = 94_702n;

/**
 * Virtual chain height at construction, on the order of live Monad testnet.
 *
 * Not cosmetic. Height zero is now unusable: epoch 0 begins at block 0, its anchor
 * would be `blockhash(-1)`, and the contract returns zero there — so a mock started
 * at zero reverts `EpochNotAnchored` on its first read. Starting at a realistic
 * height also means the epoch arithmetic is exercised at the magnitude it will
 * actually run at rather than in single digits.
 */
const DEFAULT_START_BLOCK = 48_000_000n;

export interface MockAdapterOptions {
  /** Starting book value. Defaults to 100 MON, matching the contract tests. */
  principal?: bigint;
  /** Virtual block height at construction. Must be past epoch 0. */
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

  /**
   * Epoch => the block hash its market was drawn from. Written once, on the first
   * rebalance that settles inside the epoch, never overwritten. Mirrors
   * `LeashVault._epochAnchors`, and exists for the same reason: it is what keeps a
   * past epoch verifiable after its anchor has aged out of the blockhash window.
   */
  private readonly epochAnchors = new Map<bigint, `0x${string}`>();

  private txCount = 0;
  private totalGas = 0n;

  constructor(options: MockAdapterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.blockTimeMs = options.blockTimeMs ?? MONAD_BLOCK_TIME_MS;
    this.startBlock = options.startBlock ?? DEFAULT_START_BLOCK;
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

    // Pin this epoch's market into storage before settling against it, matching the
    // contract's ordering. A rebalance in an epoch with no readable anchor throws
    // here, before any value moves.
    const atBlock = this.blockNumber();
    this.settle(this.anchorEpoch(this.currentEpoch(atBlock), atBlock));

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

  async getEpoch(): Promise<bigint> {
    return this.currentEpoch();
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

  /** The epoch the virtual chain is currently in. Mirrors `LeashVault.currentEpoch`. */
  currentEpoch(atBlock = this.blockNumber()): bigint {
    return atBlock / RATE_EPOCH_BLOCKS;
  }

  /**
   * `keccak256(abi.encode(anchor, strategyId)) % 401 - 200`, byte-identical to
   * `LeashVault.rateFromAnchor`. Pure, and public for the same reason it is public
   * on-chain: "anyone can verify our market" is only true if anyone can run the
   * derivation. Verified against Foundry's own keccak in the unit tests.
   */
  rateFromAnchor(anchor: `0x${string}`, strategyId: number): bigint {
    const seed = BigInt(
      keccak256(
        encodeAbiParameters([{type: "bytes32"}, {type: "uint256"}], [anchor, BigInt(strategyId)]),
      ),
    );
    const span = 2n * MAX_ABS_RATE_BPS + 1n;
    return (seed % span) - MAX_ABS_RATE_BPS;
  }

  /**
   * The anchor an epoch's market was drawn from, or `ZERO_HASH` if it has neither
   * been settled nor started. Mirrors `LeashVault.epochAnchor`: stored first, live
   * lookup second.
   */
  epochAnchor(epoch: bigint, atBlock = this.blockNumber()): `0x${string}` {
    return this.epochAnchors.get(epoch) ?? this.liveAnchor(epoch, atBlock);
  }

  /**
   * The rate a strategy paid in a settled or currently running epoch.
   *
   * Throws {@link EpochNotAnchored} for an epoch that has not begun — that is the
   * point, not a rough edge. Before `d8f41d3` this was a pure function of the epoch
   * number, which made every future market computable today; an agent could have
   * solved the game instead of learning it. It throws equally for a past epoch
   * nobody rebalanced in, because no rate was ever applied then.
   */
  rateAtEpoch(epoch: bigint, strategyId: number, atBlock = this.blockNumber()): bigint {
    return this.rateFromAnchor(this.requireAnchor(epoch, atBlock), strategyId);
  }

  strategyRateBps(strategyId: number, atBlock = this.blockNumber()): bigint {
    return this.rateAtEpoch(this.currentEpoch(atBlock), strategyId, atBlock);
  }

  /* --------------------------------- Internals ------------------------------- */

  private timestampSeconds(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  private strategyRates(): bigint[] {
    const at = this.blockNumber();
    return Array.from({length: STRATEGY_COUNT}, (_, i) => this.strategyRateBps(i, at));
  }

  /**
   * The hash of the block immediately before `epoch` began, or `ZERO_HASH` when it
   * is unreadable. Reproduces `blockhash`'s two blind spots exactly, because both
   * are load-bearing:
   *
   * - **Ahead of the chain.** `blockhash(n)` is zero for any `n >= block.number`,
   *   which is what makes a future epoch's market unknowable.
   * - **Past the 256 block window.** A hash that has aged out reads as zero, which
   *   is why the contract stores the anchor on first use instead of recomputing it.
   *
   * Inside a running epoch neither applies: `RATE_EPOCH_BLOCKS` is 200, so the
   * epoch's start is at most 200 blocks back and the anchor always resolves. That
   * relationship is the invariant `RATE_EPOCH_BLOCKS < BLOCKHASH_WINDOW_BLOCKS`,
   * asserted in the tests on both sides of the seam.
   */
  private liveAnchor(epoch: bigint, atBlock: bigint): `0x${string}` {
    const epochStart = epoch * RATE_EPOCH_BLOCKS;
    // Epoch 0 would need `blockhash(-1)`; the contract's uint256 start is zero and
    // it bails out before underflowing.
    if (epochStart === 0n) return ZERO_HASH;

    const target = epochStart - 1n;
    if (target >= atBlock) return ZERO_HASH;
    if (atBlock - target > BLOCKHASH_WINDOW_BLOCKS) return ZERO_HASH;

    return syntheticBlockHash(target);
  }

  /** Mirrors `LeashVault._requireAnchor`: stored, else live, else revert. */
  private requireAnchor(epoch: bigint, atBlock: bigint): `0x${string}` {
    const stored = this.epochAnchors.get(epoch);
    if (stored !== undefined) return stored;

    const live = this.liveAnchor(epoch, atBlock);
    if (live === ZERO_HASH) throw new EpochNotAnchored(epoch);
    return live;
  }

  /**
   * Pins an epoch's anchor into storage the first time it is settled, so the period
   * the agent was just paid for stays verifiable once its block hash ages out.
   * Mirrors `LeashVault._anchorEpoch` — one write per epoch, never overwritten.
   */
  private anchorEpoch(epoch: bigint, atBlock: bigint): `0x${string}` {
    const stored = this.epochAnchors.get(epoch);
    if (stored !== undefined) return stored;

    const live = this.liveAnchor(epoch, atBlock);
    if (live === ZERO_HASH) throw new EpochNotAnchored(epoch);

    this.epochAnchors.set(epoch, live);
    return live;
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
  private settle(anchor: `0x${string}`): bigint {
    const bps = BigInt(BPS_DENOMINATOR);

    let portfolioRateBps = 0n;
    for (let i = 0; i < STRATEGY_COUNT; i++) {
      portfolioRateBps += this.weights[i] * this.rateFromAnchor(anchor, i);
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
