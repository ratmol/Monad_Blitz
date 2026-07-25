"use client";

import type {NetworkTelemetry} from "../../lib/chain/network";
import {formatGwei, formatInt} from "./primitives";
import {useChangeFlash, useSmoothNumber} from "./useSmoothNumber";

/**
 * Section 3 — replaces the old bordered "LIVE ON MONAD" strip.
 *
 * That strip read as a stock ticker bolted onto a marketing page. This version keeps
 * the same measured numbers (see network.ts for why they are sampled rather than
 * asserted) but drops the badge-and-box chrome entirely: no border, no panel surface,
 * just large mono figures floating on the page's own background with a single dot for
 * liveness. The claim is "this is a reading, not a slide" — the typography should say
 * that on its own, without a box telling you to trust it.
 */
export function NetworkTether({network}: {network: NetworkTelemetry}) {
  const flashing = useChangeFlash(network.blockHeight);
  const blockTime = useSmoothNumber(network.blockTimeMs ?? 0, 900);
  const dead = network.error !== null && network.blockHeight === "0";

  return (
    <section className="snap-section relative flex min-h-screen flex-col justify-center px-6 py-24 sm:px-10 lg:px-16">
      <div className="mx-auto w-full max-w-4xl">
        <div className="flex items-center gap-2.5">
          <span
            className={`h-2 w-2 rounded-full ${
              dead ? "bg-loss" : network.stale ? "bg-warn" : "bg-gain pulse-dot"
            }`}
            aria-hidden
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-dim">
            {dead ? "network unreachable" : network.stale ? "reconnecting" : "Monad testnet, right now"}
          </span>
        </div>

        <h2 className="display mt-4 text-[13vw] text-foreground sm:text-6xl">
          Fast enough
          <br />
          to act on.
        </h2>

        <div className="mt-12 grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-4">
          <Reading label="Block" value={dead ? "—" : formatInt(network.blockHeight)} flash={flashing} />
          <Reading
            label="Block time"
            value={network.blockTimeMs === null ? "—" : `${blockTime.toFixed(0)}ms`}
            hint="measured over 2,000 blocks"
          />
          <Reading label="Gas price" value={dead ? "—" : `${formatGwei(network.gasPriceWei)} gwei`} />
          <Reading
            label="Block fill"
            value={network.gasUsedRatio === null ? "—" : `${(network.gasUsedRatio * 100).toFixed(2)}%`}
            hint="testnet is quiet — load, not capacity"
          />
        </div>

        <p className="mt-12 max-w-lg text-[13px] leading-relaxed text-muted-dim">
          The agent needs a transaction roughly every three seconds. At sub-second
          blocks and negligible fees, that is routine here. On a chain with multi-second
          blocks and dollar-scale gas, the same strategy would spend more than it earns
          — see the numbers on that, further down.
        </p>
      </div>
    </section>
  );
}

function Reading({
  label,
  value,
  hint,
  flash,
}: {
  label: string;
  value: string;
  hint?: string;
  flash?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-dim">{label}</div>
      <div className={`mono mt-2 text-3xl font-medium leading-none sm:text-4xl ${flash ? "tick-flash" : ""}`}>
        {value}
      </div>
      {hint ? <div className="mt-2 text-[11px] text-muted-dim">{hint}</div> : null}
    </div>
  );
}
