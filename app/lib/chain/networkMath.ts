/**
 * The measurement arithmetic behind {@link file://./network.ts}, kept separate from
 * the RPC client so it can be tested without a chain or a server runtime.
 *
 * `network.ts` is marked `server-only`, which is a build tripwire rather than a
 * module a test runner can import. Splitting the pure core out is the same seam the
 * rest of this codebase uses: arithmetic that can be asserted, IO that cannot.
 */

/**
 * How far back to reach for the block-time baseline.
 *
 * Block timestamps are second-granularity while Monad blocks are ~300ms, so two
 * consecutive blocks routinely share a timestamp. Measuring across a short span
 * quantises to nonsense — over ten blocks a ±1s rounding error on a 3s span is a 33%
 * error. At ~300ms this span is about ten minutes of chain, which puts the same
 * rounding error near 0.15%.
 */
export const BLOCK_TIME_SPAN = 2_000n;

/** Newest-block observations retained for the throughput mean. */
export const MAX_SAMPLES = 40;

/** Minimum gap between RPC refreshes, independent of how often the UI asks. */
export const REFRESH_MS = 2_000;

/**
 * How often to re-measure the block-time baseline.
 *
 * Deliberately far rarer than {@link REFRESH_MS}. A chain's mean block time over ten
 * minutes does not meaningfully move in two seconds, so refetching the baseline every
 * cycle spends an RPC call to watch a number stay still. The public endpoint caps at
 * 15 requests a second across the agent, the dashboard and this sampler combined, and
 * the agent's transactions have to win that budget.
 */
export const BASELINE_REFRESH_MS = 30_000;

export interface BlockSample {
  readonly height: bigint;
  readonly txCount: number;
}

/**
 * Milliseconds per block across a span.
 *
 * Returns null rather than zero for a non-positive elapsed time: zero would render
 * as an infinitely fast chain, which reads as a bug at best and a lie at worst.
 */
export function blockTimeMsFrom(
  newerTimestampSec: bigint,
  olderTimestampSec: bigint,
  spanBlocks: bigint,
): number | null {
  if (spanBlocks <= 0n) return null;
  const elapsedSec = Number(newerTimestampSec - olderTimestampSec);
  if (elapsedSec <= 0) return null;
  return (elapsedSec * 1000) / Number(spanBlocks);
}

/** Mean transactions per block over the retained samples. Null, never zero, when empty. */
export function meanTxPerBlock(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** Observed transactions per second. Null unless both inputs are known and sane. */
export function tpsFrom(txPerBlock: number | null, blockTimeMs: number | null): number | null {
  if (txPerBlock === null || blockTimeMs === null || blockTimeMs <= 0) return null;
  return txPerBlock / (blockTimeMs / 1000);
}

/**
 * Appends an observation, keeping at most {@link MAX_SAMPLES} and ignoring repeats.
 *
 * The dashboard refreshes faster than a new block appears when the chain is quiet,
 * and counting the same block twice would silently weight it twice in the mean.
 */
export function addSample(
  samples: readonly BlockSample[],
  next: BlockSample,
): BlockSample[] {
  if (samples.some((s) => s.height === next.height)) return [...samples];
  return [...samples, next].slice(-MAX_SAMPLES);
}
