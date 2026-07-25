/**
 * Live Monad network telemetry, measured rather than asserted.
 *
 * ## Why this exists
 *
 * The "why Monad" argument used to rest entirely on stated assumptions: a block time
 * written into a constant and a gas price we picked. Those numbers are now read from
 * the public RPC at runtime, so the claim is checkable on screen rather than being a
 * bullet on a slide.
 *
 * ## What it deliberately does not claim
 *
 * Monad testnet carries one or two transactions a block, so the observed rate says
 * nothing about the chain's ceiling. It is reported as observed testnet load and
 * nothing more. The number that actually carries the argument is the measured block
 * time, which is a property of the chain and not of how busy it happens to be.
 *
 * Throughput is a *sample* mean: counting every transaction over a wide span would
 * cost one RPC call per block, so each refresh keeps the newest block it saw and
 * averages over those. {@link NetworkTelemetry.blocksSampled} travels with the number
 * so the UI can say so — a sample mean presented as a census unravels under one
 * question.
 *
 * Two RPC calls per refresh, throttled by `REFRESH_MS` and shared process-wide, so
 * the dashboard's poll rate is decoupled from the load we put on a public endpoint.
 *
 * The arithmetic lives in `networkMath.ts` so it can be tested without a chain.
 */

import "server-only";

import {createPublicClient, http, type PublicClient} from "viem";

import {MONAD_RPC_URL} from "./constants";
import {monadTestnet} from "./monad";
import {
  addSample,
  BASELINE_REFRESH_MS,
  BLOCK_TIME_SPAN,
  blockTimeMsFrom,
  type BlockSample,
  meanTxPerBlock,
  REFRESH_MS,
  tpsFrom,
} from "./networkMath";

export interface NetworkTelemetry {
  readonly chainId: number;
  readonly blockHeight: string;
  /** Measured over `BLOCK_TIME_SPAN` blocks. Null on a chain younger than that. */
  readonly blockTimeMs: number | null;
  readonly gasPriceWei: string;
  /** Sample mean over `blocksSampled` newest-block observations. */
  readonly txPerBlock: number | null;
  /** Observed testnet load, not capacity. */
  readonly tps: number | null;
  readonly blocksSampled: number;
  /** Latest block's gas used as a fraction of its limit. */
  readonly gasUsedRatio: number | null;
  readonly observedAt: number;
  /** True when the last refresh failed and these are the previous good numbers. */
  readonly stale: boolean;
  readonly error: string | null;
}

interface SamplerState {
  client: PublicClient;
  samples: BlockSample[];
  last: NetworkTelemetry | null;
  lastAttempt: number;
  inFlight: Promise<NetworkTelemetry> | null;
  /** Cached block-time reading, re-measured on `BASELINE_REFRESH_MS`. */
  blockTimeMs: number | null;
  blockTimeMeasuredAt: number;
}

/**
 * Held on `globalThis` for the same reason the agent runtime is: Next re-evaluates
 * modules on hot reload, and a module-level `const` would hand every edit a fresh
 * sampler with an empty window and a reset throttle.
 */
const KEY = Symbol.for("leash.network.sampler");
const store = globalThis as unknown as {[KEY]?: SamplerState};

function state(): SamplerState {
  const existing = store[KEY];
  if (existing) return existing;

  const created: SamplerState = {
    client: createPublicClient({
      chain: monadTestnet,
      transport: http(process.env.MONAD_RPC_URL ?? MONAD_RPC_URL),
    }) as PublicClient,
    samples: [],
    last: null,
    lastAttempt: 0,
    inFlight: null,
    blockTimeMs: null,
    blockTimeMeasuredAt: 0,
  };

  store[KEY] = created;
  return created;
}

/**
 * Current telemetry, refreshing at most once per `REFRESH_MS`.
 *
 * Concurrent callers share one in-flight refresh: the server render and the poll
 * route both want this, and firing two identical bursts at a public endpoint to
 * answer one screen is how a demo earns a rate limit.
 */
export async function networkTelemetry(): Promise<NetworkTelemetry> {
  const s = state();
  const now = Date.now();

  if (s.last !== null && now - s.lastAttempt < REFRESH_MS) return s.last;
  if (s.inFlight !== null) return s.inFlight;

  s.lastAttempt = now;
  s.inFlight = refresh(s).finally(() => {
    s.inFlight = null;
  });

  return s.inFlight;
}

async function refresh(s: SamplerState): Promise<NetworkTelemetry> {
  try {
    // One call in the common case. The block carries `baseFeePerGas`, so asking
    // `eth_gasPrice` separately would spend a second request to learn something the
    // response already contains.
    const latest = await s.client.getBlock({blockTag: "latest", includeTransactions: false});

    s.samples = addSample(s.samples, {
      height: latest.number,
      txCount: latest.transactions.length,
    });

    // The baseline is re-measured rarely: a ten-minute mean does not move in two
    // seconds, and every call here is one the agent cannot spend on a transaction.
    // Only reach for it once the chain is old enough to have one — Monad testnet
    // always is, the guard is for a fresh local chain in development.
    // Coalesced rather than read straight off the cache: this state object lives on
    // `globalThis` and survives hot reloads, so after an edit that adds a field the
    // retained object still lacks it. `undefined` would then be dropped entirely by
    // JSON.stringify and the client would see the key go missing rather than null.
    const baselineDue = Date.now() - (s.blockTimeMeasuredAt ?? 0) > BASELINE_REFRESH_MS;
    if (baselineDue && latest.number > BLOCK_TIME_SPAN) {
      const older = await s.client.getBlock({
        blockNumber: latest.number - BLOCK_TIME_SPAN,
        includeTransactions: false,
      });
      s.blockTimeMs = blockTimeMsFrom(latest.timestamp, older.timestamp, BLOCK_TIME_SPAN);
      s.blockTimeMeasuredAt = Date.now();
    }

    const blockTimeMs = s.blockTimeMs ?? null;

    const txPerBlock = meanTxPerBlock(s.samples.map((x) => x.txCount));

    const telemetry: NetworkTelemetry = {
      chainId: monadTestnet.id,
      blockHeight: latest.number.toString(),
      blockTimeMs,
      gasPriceWei: (latest.baseFeePerGas ?? 0n).toString(),
      txPerBlock,
      tps: tpsFrom(txPerBlock, blockTimeMs),
      blocksSampled: s.samples.length,
      gasUsedRatio: latest.gasLimit > 0n ? Number(latest.gasUsed) / Number(latest.gasLimit) : null,
      observedAt: Date.now(),
      stale: false,
      error: null,
    };

    s.last = telemetry;
    return telemetry;
  } catch (error) {
    // A dropped refresh must not blank the panel. Serve the previous reading, flagged
    // stale so the UI can dim it rather than present old numbers as current.
    const message = error instanceof Error ? error.message : String(error);
    const fallback: NetworkTelemetry = s.last
      ? {...s.last, stale: true, error: message}
      : {
          chainId: monadTestnet.id,
          blockHeight: "0",
          blockTimeMs: null,
          gasPriceWei: "0",
          txPerBlock: null,
          tps: null,
          blocksSampled: 0,
          gasUsedRatio: null,
          observedAt: Date.now(),
          stale: true,
          error: message,
        };

    s.last = fallback;
    return fallback;
  }
}
