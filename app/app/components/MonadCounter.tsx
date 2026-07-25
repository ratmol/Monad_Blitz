"use client";

import type {DashboardState} from "../../lib/agent/dashboard";
import {TX_PER_HOUR} from "../../lib/agent/gas";
import {formatGwei, formatInt, formatUsd, Stat} from "./primitives";

/**
 * The chain-specific argument, with its inputs shown.
 *
 * Gas *units* come from real receipts via `getStats()` — never a constant, because
 * "where did that number come from" is the first thing asked about a figure this
 * convenient. The token prices are estimates and are printed on screen as such, so
 * the comparison is auditable rather than merely dramatic.
 *
 * The daily figures extrapolate the measured per-transaction gas to the strategy's
 * actual cadence: a rebalance every 3s is 1,200/hour, 28,800/day.
 */
export function MonadCounter({
  cost,
  liveGasPriceWei,
}: {
  cost: DashboardState["cost"];
  /** Gas price read from the chain this second, for auditing the assumed one. */
  liveGasPriceWei: string;
}) {
  const {assumptions} = cost;
  const liveGwei = Number(liveGasPriceWei) / 1e9;

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="Transactions" value={formatInt(cost.txCount)} tone="agent" />
        <Stat
          label="Gas used"
          value={formatInt(cost.totalGas)}
          hint={cost.gasPerTx > 0 ? `${formatInt(Math.round(cost.gasPerTx))} per tx` : undefined}
        />
        <Stat label="Cost here" value={formatUsd(cost.monadUsd)} tone="gain" />
        <Stat
          label="Same run on L1"
          value={formatUsd(cost.ethereumUsd)}
          tone="loss"
          hint={`${formatUsd(cost.ethereumUsdPerDay)}/day sustained`}
        />
      </div>

      <div className="rounded-lg border border-border-subtle bg-surface-raised px-4 py-3.5">
        <div className="text-[13px] text-muted">
          At {formatInt(TX_PER_HOUR)} tx/hour this strategy costs{" "}
          <span className="mono font-medium text-gain">{formatUsd(cost.monadUsdPerDay)}/day</span>{" "}
          on Monad and{" "}
          <span className="mono font-medium text-loss">
            {formatUsd(cost.ethereumUsdPerDay)}/day
          </span>{" "}
          on Ethereum L1. That gap is the reason the strategy exists at all.
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-dim">
        Gas units are measured from real transaction receipts, never a constant. Token prices are
        assumptions, printed so you can check them: Ethereum at {assumptions.ethereumGasPriceGwei}{" "}
        gwei and ${assumptions.ethereumPriceUsd.toLocaleString()}/ETH, Monad at{" "}
        {assumptions.monadGasPriceGwei} gwei and ${assumptions.monadPriceUsd}/MON. Monad testnet is
        quoting <span className="mono text-muted">{formatGwei(liveGasPriceWei)} gwei</span> right
        now, so the assumption above is{" "}
        {liveGwei > assumptions.monadGasPriceGwei ? "optimistic" : "conservative"} against the live
        chain. The Ethereum figure is deliberately a quiet-day number — the argument does not need a
        congestion spike.
      </p>
    </div>
  );
}
