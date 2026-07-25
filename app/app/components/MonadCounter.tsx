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
export function MonadCounter({
  cost,
  agentBalanceWei,
  live,
}: {
  cost: DashboardState["cost"];
  agentBalanceWei: string;
  live: boolean;
}) {
  const {assumptions} = cost;

  // Hours of runway left in the agent wallet at the strategy's real cadence. This is
  // the number that actually ends a live demo, and it is worth seeing before it does.
  const balanceMon = Number(BigInt(agentBalanceWei)) / 1e18;
  const hoursLeft = cost.monadMonPerHour > 0 ? balanceMon / cost.monadMonPerHour : null;
  const lowRunway = hoursLeft !== null && hoursLeft < 1;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="Transactions" value={cost.txCount.toLocaleString()} tone="agent" />
        <Stat
          label="Gas used"
          value={Number(cost.totalGas).toLocaleString()}
          hint={cost.gasPerTx > 0 ? `${Math.round(cost.gasPerTx).toLocaleString()} per tx` : undefined}
        />
        <Stat
          label="Spent here"
          value={`${cost.monadMon.toFixed(3)} MON`}
          tone="gain"
          hint={formatUsd(cost.monadUsd)}
        />
        {live ? (
          <Stat
            label="Agent wallet"
            value={`${balanceMon.toFixed(2)} MON`}
            tone={lowRunway ? "loss" : "neutral"}
            hint={
              hoursLeft === null
                ? undefined
                : `~${hoursLeft.toFixed(1)}h left at ${cost.monadMonPerHour.toFixed(1)} MON/h`
            }
          />
        ) : (
          <Stat
            label="Burn rate"
            value={`${cost.monadMonPerHour.toFixed(1)} MON/h`}
            hint="at 1,200 tx/hour"
          />
        )}
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
