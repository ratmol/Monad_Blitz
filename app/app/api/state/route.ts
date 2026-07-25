import {NextResponse} from "next/server";

import {EpochNotAnchored} from "../../../lib/chain/adapter";
import {explorerAddressUrl, MAX_DRAWDOWN_BPS, TICK_INTERVAL_MS} from "../../../lib/chain/constants";
import type {DashboardState} from "../../../lib/agent/dashboard";
import {compareCost} from "../../../lib/agent/gas";
import {runtime} from "../../../lib/agent/runtime";
import {networkTelemetry} from "../../../lib/chain/network";

/**
 * Everything the dashboard renders, in one request.
 *
 * The agent already sends a transaction every three seconds against a public RPC;
 * a dashboard that fanned out four reads per poll on top of that is how you get
 * rate-limited off a free endpoint mid-demo. One route, one payload.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const {loop, adapter, mode} = runtime();

  const snapshot = loop.snapshot();
  const stats = await adapter.getStats();

  // Reads that touch the chain are individually fallible and individually
  // non-essential. A dead balance read must not blank the whole dashboard.
  // Network telemetry is independently throttled and never throws, so it rides
  // alongside rather than gating the rest of the payload.
  const [vault, network] = await Promise.all([readVault(adapter), networkTelemetry()]);

  const payload: DashboardState = {
    mode,
    running: snapshot.running,
    converged: snapshot.converged,
    resets: snapshot.resets,
    lastError: snapshot.lastError,
    tickIntervalMs: TICK_INTERVAL_MS,
    maxDrawdownBps: MAX_DRAWDOWN_BPS,
    history: [...snapshot.history],
    arms: snapshot.arms,
    cost: serialiseCost(compareCost(stats.txCount, stats.totalGas)),
    vault,
    links: {
      // Suppressed on the mock rather than pointed at an explorer that would 404.
      vault: mode === "live" ? explorerAddressUrl(adapter.getVaultAddress()) : null,
      agent: mode === "live" ? explorerAddressUrl(adapter.getAgentAddress()) : null,
    },
    network,
  };

  return NextResponse.json(payload);
}

async function readVault(adapter: ReturnType<typeof runtime>["adapter"]) {
  const base = {
    address: adapter.getVaultAddress(),
    agent: adapter.getAgentAddress(),
  };

  try {
    const [state, balance, epoch] = await Promise.all([
      adapter.getState(),
      adapter.getAgentBalance(),
      adapter.getEpoch(),
    ]);

    return {
      ...base,
      weights: state.weights,
      totalValue: state.totalValue,
      halted: state.halted,
      // Empty when the current epoch has no anchor yet. Rendered as "no market",
      // never as zeroes — zeroes would read as a genuine break-even market.
      rates: state.rates,
      agentBalanceWei: balance.toString(),
      epoch: epoch.toString(),
      error: null as string | null,
    };
  } catch (error) {
    return {
      ...base,
      weights: [] as number[],
      totalValue: 0,
      halted: false,
      rates: [] as number[],
      agentBalanceWei: "0",
      epoch: null as string | null,
      error: error instanceof EpochNotAnchored ? error.message : String(error),
    };
  }
}

/** bigint does not survive JSON.stringify, and a silent throw here would blank the page. */
function serialiseCost(cost: ReturnType<typeof compareCost>) {
  return {...cost, totalGas: cost.totalGas.toString()};
}
