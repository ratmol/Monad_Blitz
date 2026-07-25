"use client";

import type {NetworkTelemetry} from "../../lib/chain/network";
import {formatGwei, formatInt} from "./primitives";
import {useChangeFlash, useSmoothNumber} from "./useSmoothNumber";

/**
 * Live Monad, measured from the public RPC.
 *
 * ## Why this band is at the top
 *
 * Everything below it is our vault. This is the chain itself, and while the contract
 * is unbroadcast it is the only genuinely live chain data on the screen. It also
 * turns the "why Monad" argument from an assertion into a reading: the block time
 * here is measured over two thousand blocks at request time, not copied out of a
 * constant.
 *
 * ## What it refuses to imply
 *
 * Monad testnet carries one or two transactions a block. Presenting that as the
 * chain's throughput would be both wrong and trivially checkable against any block
 * explorer, so the load figure is labelled as observed and sits in grayscale next to
 * the sample size. The number doing the persuading is the block time, which is a
 * property of the chain rather than of how busy it is today.
 */
export function NetworkBand({network}: {network: NetworkTelemetry}) {
  const flashing = useChangeFlash(network.blockHeight);
  const blockTime = useSmoothNumber(network.blockTimeMs ?? 0, 900);
  const tps = useSmoothNumber(network.tps ?? 0, 900);

  const dead = network.error !== null && network.blockHeight === "0";

  return (
    <section
      className="panel-in flex flex-wrap items-center gap-x-10 gap-y-4 rounded-[10px] border border-border-subtle bg-surface px-5 py-3.5"
      aria-label="Monad network telemetry"
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 rounded-full ${
            dead ? "bg-loss" : network.stale ? "bg-warn" : "bg-gain pulse-dot"
          }`}
          aria-hidden
        />
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-dim">
            {dead ? "network unreachable" : network.stale ? "reconnecting" : "monad testnet"}
          </div>
          <div className="mono text-[13px] text-muted">chain {network.chainId}</div>
        </div>
      </div>

      <Reading
        label="Block"
        value={dead ? "—" : formatInt(network.blockHeight)}
        className={flashing ? "tick-flash" : undefined}
      />

      <Reading
        label="Block time"
        value={network.blockTimeMs === null ? "—" : `${blockTime.toFixed(0)} ms`}
        hint="measured over 2,000 blocks"
      />

      <Reading
        label="Gas price"
        value={dead ? "—" : `${formatGwei(network.gasPriceWei)} gwei`}
      />

      <Reading
        label="Observed load"
        value={network.tps === null ? "—" : `${tps.toFixed(1)} tx/s`}
        hint={
          network.blocksSampled === 0
            ? "sampling"
            : `sampled over ${network.blocksSampled} block${network.blocksSampled === 1 ? "" : "s"}`
        }
      />

      <Reading
        label="Block fill"
        value={
          network.gasUsedRatio === null ? "—" : `${(network.gasUsedRatio * 100).toFixed(2)}%`
        }
        hint="testnet is quiet — this is load, not capacity"
      />
    </section>
  );
}

function Reading({
  label,
  value,
  hint,
  className = "",
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-dim">
        {label}
      </div>
      <div className={`mono mt-1 text-xl font-medium leading-none ${className}`}>{value}</div>
      {hint ? <div className="mt-1.5 text-[10px] text-muted-dim">{hint}</div> : null}
    </div>
  );
}
