import {Dashboard} from "./components/Dashboard";
import {EpochNotAnchored} from "../lib/chain/adapter";
import {explorerAddressUrl, MAX_DRAWDOWN_BPS, TICK_INTERVAL_MS} from "../lib/chain/constants";
import type {DashboardState} from "../lib/agent/dashboard";
import {compareCost} from "../lib/agent/gas";
import {runtime} from "../lib/agent/runtime";

/**
 * Server shell. Reads state once so the first paint already has data — a dashboard
 * that flashes empty for a second is a dashboard that flashes empty on a projector.
 *
 * The agent starts here rather than waiting for a button. The demo plan is explicit
 * that there must be history on screen before the pitch begins, and a cold start is
 * the one state the run cannot afford.
 */
export const dynamic = "force-dynamic";

export default async function Page() {
  const {loop, adapter, mode} = runtime();
  loop.start();

  const snapshot = loop.snapshot();
  const stats = await adapter.getStats();
  const cost = compareCost(stats.txCount, stats.totalGas);

  let vault: DashboardState["vault"];
  try {
    const [state, balance, epoch] = await Promise.all([
      adapter.getState(),
      adapter.getAgentBalance(),
      adapter.getEpoch(),
    ]);
    vault = {
      address: adapter.getVaultAddress(),
      agent: adapter.getAgentAddress(),
      weights: state.weights,
      totalValue: state.totalValue,
      halted: state.halted,
      rates: state.rates,
      agentBalanceWei: balance.toString(),
      epoch: epoch.toString(),
      error: null,
    };
  } catch (error) {
    // First paint must not be an error page. The client polls a second later and
    // recovers on its own if this was a transient RPC failure.
    vault = {
      address: adapter.getVaultAddress(),
      agent: adapter.getAgentAddress(),
      weights: [],
      totalValue: 0,
      halted: false,
      rates: [],
      agentBalanceWei: "0",
      epoch: null,
      error: error instanceof EpochNotAnchored ? error.message : String(error),
    };
  }

  const initial: DashboardState = {
    mode,
    running: snapshot.running,
    converged: snapshot.converged,
    resets: snapshot.resets,
    lastError: snapshot.lastError,
    tickIntervalMs: TICK_INTERVAL_MS,
    maxDrawdownBps: MAX_DRAWDOWN_BPS,
    history: [...snapshot.history],
    arms: snapshot.arms,
    cost: {...cost, totalGas: cost.totalGas.toString()},
    vault,
    links: {
      vault: mode === "live" ? explorerAddressUrl(adapter.getVaultAddress()) : null,
      agent: mode === "live" ? explorerAddressUrl(adapter.getAgentAddress()) : null,
    },
  };

  return <Dashboard initial={initial} />;
}
