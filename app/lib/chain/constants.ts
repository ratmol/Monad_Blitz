/**
 * Mirrors the constants in `contracts/src/LeashVault.sol`.
 *
 * These are duplicated deliberately rather than read from the chain: the bandit
 * needs the weight cap to propose allocations the contract will actually accept,
 * and the mock adapter needs the whole set to reproduce on-chain behaviour without
 * a chain. If a constant changes in the contract it must change here too — the
 * mock adapter's tests assert the derived values, so a drift shows up as a failure
 * rather than as an agent that silently wastes every transaction.
 */

export const BPS_DENOMINATOR = 10_000;
export const STRATEGY_COUNT = 3;

/** No single strategy may hold more than 60% of the book. */
export const MAX_WEIGHT_BPS = 6_000;

/** Minimum seconds between reallocations, enforced on-chain. */
export const REBALANCE_COOLDOWN_SECONDS = 2;

/**
 * The agent's tick interval. Must be strictly greater than the cooldown or roughly
 * half of every transaction reverts on the cooldown check.
 */
export const TICK_INTERVAL_MS = 3_000;

/** A drawdown past 15% from the high water mark trips the breaker. */
export const MAX_DRAWDOWN_BPS = 1_500;

/** Per-period strategy return is uniform over [-2%, +2%]. Break-even is zero. */
export const MAX_ABS_RATE_BPS = 200n;

/**
 * Blocks a rate holds for before it is redrawn. ~200 blocks is about a minute at
 * Monad's block time, or roughly twenty ticks — long enough for the bandit to
 * learn a rate, short enough that it changes a few times during a demo.
 */
export const RATE_EPOCH_BLOCKS = 200n;

/** Monad testnet. */
export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_RPC_URL = "https://testnet-rpc.monad.xyz";
export const MONAD_EXPLORER_URL = "https://testnet.monadexplorer.com";

/**
 * Monad block time since the MIP-12 hard fork of June 2026, down from 400ms. The
 * mock adapter advances its virtual chain at this rate so timings developed
 * against the mock hold against the real one.
 */
export const MONAD_BLOCK_TIME_MS = 300;

export function explorerTxUrl(txHash: string): string {
  return `${MONAD_EXPLORER_URL}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${MONAD_EXPLORER_URL}/address/${address}`;
}
