"use client";

import type {DashboardState} from "../../lib/agent/dashboard";
import {TX_PER_HOUR} from "../../lib/agent/gas";
import {formatGwei, formatInt, formatUsd, formatWeiMon, Stat} from "./primitives";

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
  agentBalanceWei,
  live,
}: {
  cost: DashboardState["cost"];
  /** Gas price read from the chain this second, for auditing the assumed one. */
  liveGasPriceWei: string;
  agentBalanceWei: string;
  live: boolean;
}) {
  const {assumptions} = cost;
  const liveGwei = Number(liveGasPriceWei) / 1e9;
  const runway = runwayHours(cost.gasPerTx, liveGasPriceWei, agentBalanceWei);

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="Transactions" value={formatInt(cost.txCount)} tone="agent" />
        <Stat
          label="Gas used"
          value={formatInt(cost.totalGas)}
          hint={cost.gasPerTx > 0 ? `${formatInt(Math.round(cost.gasPerTx))} per tx` : undefined}
        />
        <Stat
          label="Cost here"
          value={formatUsd(cost.monadUsd)}
          tone="gain"
          hint={`${cost.monadMon.toFixed(3)} MON`}
        />
        <Stat
          label="Same run on L1"
          value={formatUsd(cost.ethereumUsd)}
          tone="loss"
          hint={`${formatUsd(cost.ethereumUsdPerDay)}/day sustained`}
        />
      </div>

      {/* The out-of-gas banner fires once the wallet can no longer afford a single
          transaction — by then the demo has already stopped. This is the warning
          that comes before that, priced off the live base fee rather than the
          assumption above, because the assumption is what would be wrong first. */}
      {live && runway !== null ? (
        <div
          className={`rounded-lg border px-4 py-3.5 ${
            runway < 1 ? "border-loss/50 bg-loss/[0.06]" : "border-border-subtle bg-surface-raised"
          }`}
        >
          <div className="text-[13px] text-muted">
            Agent wallet holds{" "}
            <span className="mono font-medium text-foreground">
              {formatWeiMon(agentBalanceWei)} MON
            </span>
            , which is{" "}
            <span className={`mono font-medium ${runway < 1 ? "text-loss" : "text-foreground"}`}>
              ~{runway.toFixed(1)}h
            </span>{" "}
            of runway at {formatInt(TX_PER_HOUR)} tx/hour and the current base fee.
            {runway < 1 ? " Top it up from the faucet before pitching." : ""}
          </div>
        </div>
      ) : null}

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

/**
 * Hours the agent wallet can keep trading, at the live base fee.
 *
 * Priced off `liveGasPriceWei` rather than the assumed gas price on purpose: the
 * assumption exists to make the Ethereum comparison auditable, and on testnet it has
 * already been observed to double inside a single minute. Runway computed from a
 * stale constant is exactly the number you do not want to trust before a demo.
 *
 * Null when there is nothing meaningful to divide by — before the first receipt lands
 * there is no measured per-transaction gas.
 */
function runwayHours(
  gasPerTx: number,
  liveGasPriceWei: string,
  agentBalanceWei: string,
): number | null {
  if (gasPerTx <= 0) return null;

  const gasPrice = Number(liveGasPriceWei);
  if (!Number.isFinite(gasPrice) || gasPrice <= 0) return null;

  const burnPerHourWei = gasPerTx * gasPrice * TX_PER_HOUR;
  if (burnPerHourWei <= 0) return null;

  return Number(agentBalanceWei) / burnPerHourWei;
}
