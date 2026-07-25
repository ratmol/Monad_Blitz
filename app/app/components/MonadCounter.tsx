"use client";

import type {DashboardState} from "../../lib/agent/dashboard";
import {TX_PER_HOUR} from "../../lib/agent/gas";
import {formatUsd, Stat} from "./primitives";

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
export function MonadCounter({cost}: {cost: DashboardState["cost"]}) {
  const {assumptions} = cost;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
        <Stat label="Transactions" value={cost.txCount.toLocaleString()} tone="agent" />
        <Stat
          label="Gas used"
          value={Number(cost.totalGas).toLocaleString()}
          hint={cost.gasPerTx > 0 ? `${Math.round(cost.gasPerTx).toLocaleString()} per tx` : undefined}
        />
        <Stat label="Cost here" value={formatUsd(cost.monadUsd)} tone="gain" />
      </div>

      <div className="rounded-lg border border-loss/40 bg-loss/5 p-4">
        <div className="text-xs font-semibold uppercase tracking-widest text-loss">
          Same run on Ethereum L1
        </div>
        <div className="tabular mt-1 text-4xl font-bold text-loss">
          {formatUsd(cost.ethereumUsd)}
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
          <span className="text-muted">
            At {TX_PER_HOUR.toLocaleString()} tx/hour, sustained:{" "}
            <span className="tabular font-bold text-loss">
              {formatUsd(cost.ethereumUsdPerDay)}/day
            </span>{" "}
            vs{" "}
            <span className="tabular font-bold text-gain">
              {formatUsd(cost.monadUsdPerDay)}/day
            </span>{" "}
            here.
          </span>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-muted">
        Gas units are measured from real transaction receipts. Prices are assumptions, stated so you
        can check them: Ethereum at {assumptions.ethereumGasPriceGwei} gwei and $
        {assumptions.ethereumPriceUsd.toLocaleString()}/ETH, Monad at{" "}
        {assumptions.monadGasPriceGwei} gwei and ${assumptions.monadPriceUsd}/MON. The Ethereum gas
        price is deliberately a quiet-day number — the argument does not need a congestion spike.
      </p>
    </div>
  );
}
