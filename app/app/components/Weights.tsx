"use client";

import {BPS_DENOMINATOR, MAX_WEIGHT_BPS} from "../../lib/chain/constants";
import {formatBps} from "./primitives";

/**
 * Current allocation, with the cap drawn as a line the bars visibly cannot cross.
 *
 * The cap marker is the point of this panel, not decoration. The agent's preferred
 * move is always 100% into whatever is paying best; the contract refuses past 6000
 * bps. Seeing a bar pinned exactly at the line, every time, is the leash made
 * visible — and it is a better demonstration of the constraint than any sentence.
 */
export function Weights({
  weights,
  rates,
}: {
  weights: number[];
  rates: number[];
}) {
  if (weights.length === 0) {
    return <div className="text-muted">No allocation read yet…</div>;
  }

  const capPercent = (MAX_WEIGHT_BPS / BPS_DENOMINATOR) * 100;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="relative">
        {/* The cap, drawn once across the whole stack so the eye reads it as a wall. */}
        <div
          className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-warn/70"
          style={{left: `${capPercent}%`}}
          aria-hidden
        >
          <span className="absolute -top-0.5 left-2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] text-warn">
            {capPercent}% cap
          </span>
        </div>

        <div className="flex flex-col gap-2.5 pt-5">
          {weights.map((bps, i) => {
            const percent = (bps / BPS_DENOMINATOR) * 100;
            const atCap = bps >= MAX_WEIGHT_BPS;
            const rate = rates[i];
            return (
              <div key={i} className="flex items-center gap-3">
                <span className="mono w-8 shrink-0 text-[13px] text-muted">S{i}</span>
                <div className="h-7 flex-1 overflow-hidden rounded-md bg-surface-raised">
                  <div
                    className={`h-full rounded-md transition-[width] duration-500 ${
                      atCap ? "bg-warn/80" : "bg-agent/80"
                    }`}
                    style={{width: `${percent}%`}}
                  />
                </div>
                <span className="mono w-12 shrink-0 text-right text-[15px] font-medium">
                  {percent.toFixed(0)}%
                </span>
                <span
                  className={`mono w-20 shrink-0 text-right text-[13px] ${
                    rate === undefined ? "text-muted-dim" : rate >= 0 ? "text-gain" : "text-loss"
                  }`}
                >
                  {rate === undefined ? "no market" : formatBps(rate)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-auto text-[11px] leading-relaxed text-muted-dim">
        Rates are this epoch&apos;s on-chain returns, readable by anyone via{" "}
        <code className="mono text-muted">strategyRates()</code>. The agent never reads them — it
        learns from what its own allocations actually paid.
      </p>
    </div>
  );
}
