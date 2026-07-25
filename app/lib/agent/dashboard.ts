import type {ArmStats} from "./bandit";
import type {CostAssumptions} from "./gas";
import type {TickRecord} from "./loop";

/**
 * The exact shape `/api/state` returns.
 *
 * Shared by the route handler and the client so the two cannot drift: the route is
 * typed as returning this, the dashboard is typed as consuming it, and a field
 * renamed on one side is a compile error on the other rather than `undefined` on a
 * projector.
 *
 * `bigint` is absent on purpose — it does not survive `JSON.stringify`, so gas and
 * balances cross as decimal strings and are widened at the edge.
 */
export interface DashboardState {
  mode: "mock" | "live";
  running: boolean;
  converged: boolean;
  resets: number;
  lastError: string | null;
  tickIntervalMs: number;
  maxDrawdownBps: number;
  history: TickRecord[];
  arms: ArmStats[];
  cost: {
    txCount: number;
    totalGas: string;
    gasPerTx: number;
    monadUsd: number;
    ethereumUsd: number;
    ethereumUsdPerDay: number;
    monadUsdPerDay: number;
    monadMon: number;
    monadMonPerHour: number;
    assumptions: CostAssumptions;
  };
  vault: {
    address: string;
    agent: string;
    weights: number[];
    totalValue: number;
    halted: boolean;
    /** Empty when the current epoch has no anchor. Render as "no market", not zeroes. */
    rates: number[];
    agentBalanceWei: string;
    epoch: string | null;
    error: string | null;
  };
  links: {
    vault: string | null;
    agent: string | null;
  };
}
