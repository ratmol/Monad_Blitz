"use client";

import {useCallback, useEffect, useRef, useState} from "react";

import type {DashboardState} from "../../lib/agent/dashboard";
import {phaseOf, runInsight, type RunInsight} from "../../lib/agent/insights";
import {
  BPS_DENOMINATOR,
  LOW_BALANCE_WARN_WEI,
  MAX_WEIGHT_BPS,
  REBALANCE_COOLDOWN_SECONDS,
} from "../../lib/chain/constants";
import {AgentThoughts} from "./AgentThoughts";
import {ArmScores} from "./ArmScores";
import {MonadCounter} from "./MonadCounter";
import {RaceChart} from "./RaceChart";
import {TxFeed} from "./TxFeed";
import {Weights} from "./Weights";
import {
  AddressStat,
  Badge,
  formatBps,
  formatMagnitude,
  formatMon,
  formatWeiMon,
  Panel,
  RailLabel,
} from "./primitives";
import {useSmoothNumber} from "./useSmoothNumber";

/**
 * Polls `/api/state` on an interval and renders everything.
 *
 * Interval, not per-block. Monad produces a block every ~300ms; polling per block
 * would be ~3.3 requests a second on top of the agent's own transaction every 3s,
 * and a free RPC endpoint will throttle that away mid-demo. One request per second
 * against our own route, which does the chain reads once and shares them.
 */

const POLL_MS = 1_000;

export function Dashboard({initial}: {initial: DashboardState}) {
  const [state, setState] = useState(initial);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  // Held in a ref so a slow response cannot overwrite a newer one out of order.
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const response = await fetch("/api/state", {cache: "no-store"});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = (await response.json()) as DashboardState;
        if (!cancelled) {
          setState(next);
          setStale(false);
        }
      } catch {
        // A dropped poll is a blip, not an outage. Mark the header and keep trying;
        // blanking the screen because one request failed is the worse failure mode.
        if (!cancelled) setStale(true);
      } finally {
        inFlight.current = false;
      }
    }

    const id = setInterval(poll, POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const control = useCallback(async (action: "start" | "stop" | "reset") => {
    setBusy(true);
    try {
      await fetch("/api/control", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({action}),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const {vault, cost, history} = state;
  const latest = history.at(-1);
  const drawdown = drawdownBps(history);
  const insight = runInsight(history);
  const phase = phaseOf(history, state.converged, state.running);

  return (
    <div className="flex min-h-screen flex-col">
      <TopNav state={state} stale={stale} busy={busy} phase={phase} onControl={control} />

      <div className="flex flex-1 flex-col lg:flex-row">
        <Rail state={state} />

        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:p-5">
          {vault.halted ? <HaltBanner drawdownBps={drawdown} max={state.maxDrawdownBps} /> : null}
          {outOfGas(state) ? <OutOfGasBanner state={state} /> : null}
          {vault.error ? (
            <div className="rounded-[10px] border border-warn/30 bg-warn/[0.04] px-5 py-3.5 text-[13px] text-warn">
              Chain read failed: {vault.error}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel
              order={1}
              className="xl:col-span-2"
              title="Vault value"
              subtitle="Same market, same tick rate, same arithmetic. The only difference is the allocation policy."
              right={latest ? <HeroValue latest={latest} insight={insight} /> : null}
            >
              <RaceChart history={history} epochBoundaries={insight.epochBoundaries} />
              <EdgeStrip insight={insight} phase={phase} />
            </Panel>

            <Panel
              order={2}
              title="What the agent believes"
              subtitle="Mean realised return per allocation, in bps."
            >
              <ArmScores arms={state.arms} converged={state.converged} resets={state.resets} />
            </Panel>

            <Panel
              order={3}
              title="Allocation"
              subtitle={vault.epoch ? `Epoch ${vault.epoch}` : "Epoch unknown"}
            >
              <Weights weights={vault.weights} rates={vault.rates} />
            </Panel>

            <Panel
              order={4}
              className="xl:col-span-2"
              title="Cost of acting this often"
              subtitle="Gas measured from real receipts; comparison prices are stated assumptions."
            >
              <MonadCounter cost={cost} liveGasPriceWei={state.network.gasPriceWei} />
            </Panel>

            <Panel
              order={5}
              className="xl:col-span-3"
              title="Agent thoughts"
              subtitle="A narrative reading of the same decisions, off the same fields."
            >
              <AgentThoughts history={history} running={state.running} />
            </Panel>

            <Panel
              order={6}
              className="xl:col-span-3"
              title="Decision log"
              subtitle="Every rebalance, with the rationale whose hash went on-chain."
            >
              <TxFeed history={history} live={state.mode === "live"} />
            </Panel>
          </div>

          <Footer state={state} />
        </main>
      </div>
    </div>
  );
}

/* ---------------------------------- chrome --------------------------------- */

function TopNav({
  state,
  stale,
  busy,
  phase,
  onControl,
}: {
  state: DashboardState;
  stale: boolean;
  busy: boolean;
  phase: ReturnType<typeof phaseOf>;
  onControl: (action: "start" | "stop" | "reset") => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle bg-background/85 px-5 py-3 backdrop-blur-sm">
      <div className="flex items-baseline gap-3">
        <span className="text-[15px] font-semibold tracking-[0.2em]">LEASH</span>
        <span className="hidden text-[13px] text-muted-dim sm:inline">
          an agent that can grow your money but never take it
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {/* Mock vs live is derived from the environment, not a toggle someone forgets to
            flip. Stated quietly in text rather than a badge — the network section above
            the fold already carries the "is this real" claim; repeating it here as a
            second loud box was redundant chrome. */}
        <span className="text-[11px] text-muted-dim">
          {state.mode === "live" ? "vault live on monad" : "vault simulated"}
        </span>
        <PhaseBadge phase={phase} />
        {stale ? <Badge tone="loss">reconnecting</Badge> : null}

        <div className="ml-1 flex gap-2">
          <Button onClick={() => onControl(state.running ? "stop" : "start")} disabled={busy}>
            {state.running ? "Stop" : "Start"}
          </Button>
          {/* Kept visible for the "show me it learning from scratch" question. It
              clears the estimates and the chart, never the vault's book. */}
          <Button onClick={() => onControl("reset")} disabled={busy}>
            Reset learning
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * The left rail states the project's actual claim and never changes shape.
 *
 * It is not navigation — there is one screen, and inventing links to pages that do
 * not exist is the kind of filler that makes everything beside it look invented too.
 * What belongs here permanently is the leash itself: the four constraints the agent
 * cannot break, in the contract's own units, next to the two addresses that prove
 * custody and operation are separate roles.
 */
function Rail({state}: {state: DashboardState}) {
  const {vault} = state;
  const lowBalance =
    state.mode === "live" && BigInt(vault.agentBalanceWei) < LOW_BALANCE_WARN_WEI;

  return (
    <aside className="shrink-0 border-b border-border-subtle p-4 lg:w-[248px] lg:border-b-0 lg:border-r lg:p-5">
      <RailLabel>Enforced on-chain</RailLabel>
      <ul className="flex flex-col gap-2.5">
        <Constraint
          label="Withdraw"
          value="owner only"
          note="the agent has no path to funds"
        />
        <Constraint
          label="Max per strategy"
          value={`${(MAX_WEIGHT_BPS / BPS_DENOMINATOR) * 100}%`}
          note={`${MAX_WEIGHT_BPS} bps cap`}
        />
        <Constraint
          label="Rebalance cooldown"
          value={`${REBALANCE_COOLDOWN_SECONDS}s`}
          note={`agent ticks every ${state.tickIntervalMs / 1000}s`}
        />
        <Constraint
          label="Drawdown halt"
          value={`${state.maxDrawdownBps / 100}%`}
          note="permanent lockout, no override"
        />
      </ul>

      <div className="my-5 h-px bg-border-subtle" />

      <RailLabel>Identity</RailLabel>
      <div className="flex flex-col gap-3.5">
        <AddressStat label="Vault" address={vault.address} href={state.links.vault} />
        <AddressStat label="Agent" address={vault.agent} href={state.links.agent} />
        {/* The agent pays its own gas. An empty wallet stops the demo dead and looks
            exactly like a crash, so the number is on screen before it becomes urgent. */}
        {state.mode === "live" ? (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-dim">
              Agent gas
            </div>
            <div className={`mono mt-1 text-[13px] ${lowBalance ? "text-loss" : ""}`}>
              {formatWeiMon(vault.agentBalanceWei)} MON
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function Constraint({label, value, note}: {label: string; value: string; note: string}) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted">{label}</span>
        <span className="mono text-[13px] font-medium">{value}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-dim">{note}</div>
    </li>
  );
}

/* --------------------------------- readouts -------------------------------- */

function HeroValue({
  latest,
  insight,
}: {
  latest: NonNullable<DashboardState["history"][number]>;
  insight: RunInsight;
}) {
  const value = useSmoothNumber(latest.agentValue);
  const baseline = useSmoothNumber(latest.baselineValue);

  return (
    <div className="text-right">
      <div className="mono text-[40px] font-medium leading-none text-foreground">
        {formatMon(value)}
      </div>
      <div className="mono mt-1.5 text-[13px] text-baseline">baseline {formatMon(baseline)}</div>
      <Lead insight={insight} />
    </div>
  );
}

/**
 * Where the agent stands against the baseline right now, gain or loss.
 *
 * Shown even when it is negative. During a sweep it often will be, and a panel that
 * only displays the number when it flatters the agent is the kind of thing that gets
 * noticed. {@link EdgeStrip} is what puts a bad instantaneous number in context.
 */
function Lead({insight}: {insight: RunInsight}) {
  if (insight.leadMon === null || insight.leadBps === null) return null;

  const ahead = insight.leadMon >= 0;
  return (
    <div className={`mono mt-1.5 text-[13px] font-medium ${ahead ? "text-gain" : "text-loss"}`}>
      {ahead ? "▲" : "▼"} {formatMon(Math.abs(insight.leadMon))} MON (
      {formatMagnitude(insight.leadBps)})
    </div>
  );
}

/**
 * The honest headline: how the agent does once it has actually learned the market.
 *
 * The instantaneous lead swings — the bandit spends the first ticks of every epoch
 * sweeping arms it has no reading on, and pays for that in return. This strip is what
 * separates "it is exploring" from "it is losing", which are indistinguishable from
 * the chart line alone and are the difference between the demo landing and not.
 */
function EdgeStrip({insight, phase}: {insight: RunInsight; phase: ReturnType<typeof phaseOf>}) {
  const edge = insight.exploitEdgeBps;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border-subtle pt-4 text-[13px]">
      {edge === null ? (
        <span className="text-muted-dim">
          Sweeping every allocation once before it starts exploiting — no learned-phase
          return to report yet.
        </span>
      ) : (
        <>
          <span className="text-muted">
            Once learned{" "}
            <span className={`mono font-medium ${edge >= 0 ? "text-gain" : "text-loss"}`}>
              {formatBps(edge)}
            </span>{" "}
            per tick vs the baseline
          </span>
          <span className="text-[11px] text-muted-dim">
            averaged over {insight.exploitTicks} settled tick
            {insight.exploitTicks === 1 ? "" : "s"} that an exploit decision earned
          </span>
        </>
      )}
      {phase === "sweeping" ? (
        <span className="text-[11px] text-warn">
          Exploring now — a sweep costs return on purpose, to find out what pays.
        </span>
      ) : null}
    </div>
  );
}

function PhaseBadge({phase}: {phase: ReturnType<typeof phaseOf>}) {
  const {tone, label} = {
    waiting: {tone: "neutral", label: "waiting for first tick"},
    stopped: {tone: "neutral", label: "agent stopped"},
    sweeping: {tone: "warn", label: "exploring"},
    exploiting: {tone: "agent", label: "exploiting"},
  }[phase] as {tone: "neutral" | "agent" | "warn"; label: string};

  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

function Button({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-border-subtle px-3 py-1.5 text-[12px] font-medium transition-colors hover:border-border-strong hover:text-agent disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function HaltBanner({drawdownBps, max}: {drawdownBps: number | null; max: number}) {
  return (
    <div className="halt-pulse rounded-[10px] border border-loss/50 bg-loss/[0.06] px-5 py-4">
      <div className="text-base font-semibold text-loss">
        Circuit breaker tripped — the agent is locked out
      </div>
      <p className="mt-1.5 text-[13px] text-muted">
        The book drew down past {(max / 100).toFixed(0)}% from its high water mark
        {drawdownBps === null ? "" : ` (${(drawdownBps / 100).toFixed(1)}%)`}, so the contract
        halted it. No human intervened, and no human can un-halt it. The owner can still
        withdraw.
      </p>
    </div>
  );
}

/**
 * Whether the agent can still afford to act, from measured numbers rather than a
 * guessed floor: gas actually consumed per rebalance, priced at the chain's current
 * base fee. Below one transaction's worth it is not "running low", it is stopped.
 *
 * Only meaningful on a live chain; the mock's balance is a fixture.
 */
function outOfGas(state: DashboardState): boolean {
  if (state.mode !== "live") return false;
  if (state.cost.gasPerTx <= 0) return false;

  const perTxWei = BigInt(Math.ceil(state.cost.gasPerTx)) * BigInt(state.network.gasPriceWei);
  if (perTxWei === 0n) return false;

  return BigInt(state.vault.agentBalanceWei) < perTxWei;
}

/**
 * The failure that looks exactly like a crash unless you say so.
 *
 * An agent whose wallet is empty reverts every transaction and produces a chart that
 * simply stops moving. Without this the screen offers no way to tell that apart from
 * a hung process, a dead RPC, or the strategy having nothing to do — and "why is it
 * frozen" is a bad question to be answered live.
 */
function OutOfGasBanner({state}: {state: DashboardState}) {
  const perTx = (state.cost.gasPerTx * Number(state.network.gasPriceWei)) / 1e18;

  return (
    <div className="rounded-[10px] border border-loss/50 bg-loss/[0.06] px-5 py-4">
      <div className="text-base font-semibold text-loss">
        Agent wallet is out of gas — every rebalance is reverting
      </div>
      <p className="mt-1.5 text-[13px] text-muted">
        The agent holds{" "}
        <span className="mono text-foreground">{formatWeiMon(state.vault.agentBalanceWei)} MON</span>{" "}
        and each rebalance costs about{" "}
        <span className="mono text-foreground">{perTx.toFixed(4)} MON</span> at the current base
        fee. Fund{" "}
        <span className="mono text-foreground">
          {state.vault.agent.slice(0, 6)}…{state.vault.agent.slice(-4)}
        </span>{" "}
        from the faucet to resume. This is the agent&apos;s own wallet, not the vault — the book
        itself is untouched, and the owner can still withdraw.
      </p>
    </div>
  );
}

function Footer({state}: {state: DashboardState}) {
  return (
    <footer className="flex flex-wrap gap-x-8 gap-y-2 px-1 pb-2 text-[11px] text-muted-dim">
      <span>
        Tick {state.tickIntervalMs / 1000}s · on-chain cooldown {REBALANCE_COOLDOWN_SECONDS}s ·
        epoch 200 blocks
      </span>
      <span>
        The agent holds no withdrawal permission. <code className="mono">withdraw()</code> is{" "}
        <code className="mono">onlyOwner</code> and reverts for the agent key.
      </span>
      {state.lastError ? <span className="text-loss">Last error: {state.lastError}</span> : null}
    </footer>
  );
}

/** Peak-to-current decline across the run, in bps — what the breaker measures. */
function drawdownBps(history: DashboardState["history"]): number | null {
  if (history.length === 0) return null;
  let peak = 0;
  let worst = 0;
  for (const tick of history) {
    if (tick.agentValue > peak) peak = tick.agentValue;
    if (peak > 0) worst = Math.max(worst, ((peak - tick.agentValue) / peak) * 10_000);
  }
  return worst;
}
