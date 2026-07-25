"use client";

import {useCallback, useEffect, useRef, useState} from "react";

import type {DashboardState} from "../../lib/agent/dashboard";
import {ArmScores} from "./ArmScores";
import {MonadCounter} from "./MonadCounter";
import {RaceChart} from "./RaceChart";
import {TxFeed} from "./TxFeed";
import {Weights} from "./Weights";
import {Badge, formatMon, Panel, Stat} from "./primitives";

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

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 p-6">
      <Header state={state} stale={stale} busy={busy} onControl={control} />

      {vault.halted ? <HaltBanner drawdownBps={drawdown} max={state.maxDrawdownBps} /> : null}
      {vault.error ? (
        <div className="rounded-lg border border-warn/40 bg-warn/5 p-4 text-sm text-warn">
          Chain read failed: {vault.error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Vault value"
          subtitle="Same market, same tick rate, same arithmetic. The only difference is the allocation policy."
          right={
            latest ? (
              <div className="text-right">
                <div className="tabular text-3xl font-bold text-agent">
                  {formatMon(latest.agentValue)}
                </div>
                <div className="tabular text-sm text-baseline">
                  baseline {formatMon(latest.baselineValue)}
                </div>
              </div>
            ) : null
          }
        >
          <RaceChart history={history} />
        </Panel>

        <Panel
          title="What the agent believes"
          subtitle="Mean realised return per allocation, in bps."
        >
          <ArmScores arms={state.arms} converged={state.converged} resets={state.resets} />
        </Panel>

        <Panel
          title="Allocation"
          subtitle={vault.epoch ? `Epoch ${vault.epoch}` : "Epoch unknown"}
        >
          <Weights weights={vault.weights} rates={vault.rates} />
        </Panel>

        <Panel
          className="xl:col-span-2"
          title="Why this only works on Monad"
          subtitle="Gas measured from real receipts; token prices are stated assumptions."
        >
          <MonadCounter cost={cost} />
        </Panel>

        <Panel
          className="xl:col-span-3"
          title="Decision log"
          subtitle="Every rebalance, with the rationale whose hash went on-chain."
          right={
            <div className="flex gap-6">
              <Stat label="Vault" value={short(vault.address)} />
              <Stat label="Agent" value={short(vault.agent)} />
            </div>
          }
        >
          <TxFeed history={history} live={state.mode === "live"} />
        </Panel>
      </div>

      <Footer state={state} />
    </main>
  );
}

function Header({
  state,
  stale,
  busy,
  onControl,
}: {
  state: DashboardState;
  stale: boolean;
  busy: boolean;
  onControl: (action: "start" | "stop" | "reset") => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-subtle bg-surface px-6 py-4">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold tracking-tight">
          LEASH
          <span className="ml-3 text-base font-normal text-muted">
            an agent that can grow your money but never take it
          </span>
        </h1>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Mock vs live is derived from the environment, not a toggle someone forgets
            to flip. Whether these numbers came from a chain is the first thing asked. */}
        <Badge tone={state.mode === "live" ? "gain" : "warn"}>
          {state.mode === "live" ? "live on monad testnet" : "simulated — no chain"}
        </Badge>
        <Badge tone={state.running ? "agent" : "neutral"}>
          {state.running ? "agent running" : "agent stopped"}
        </Badge>
        {stale ? <Badge tone="loss">reconnecting</Badge> : null}

        <div className="flex gap-2">
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
      className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-semibold transition-colors hover:border-agent hover:text-agent disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function HaltBanner({drawdownBps, max}: {drawdownBps: number | null; max: number}) {
  return (
    <div className="halt-pulse rounded-xl border-2 border-loss bg-loss/10 px-6 py-5">
      <div className="text-xl font-bold text-loss">
        Circuit breaker tripped — the agent is locked out
      </div>
      <p className="mt-1 text-sm text-foreground">
        The book drew down past {(max / 100).toFixed(0)}% from its high water mark
        {drawdownBps === null ? "" : ` (${(drawdownBps / 100).toFixed(1)}%)`}, so the contract halted
        it. No human intervened, and no human can un-halt it. The owner can still withdraw.
      </p>
    </div>
  );
}

function Footer({state}: {state: DashboardState}) {
  return (
    <footer className="flex flex-wrap gap-x-8 gap-y-2 px-2 text-xs text-muted">
      <span>Tick {state.tickIntervalMs / 1000}s · on-chain cooldown 2s · epoch 200 blocks</span>
      <span>
        The agent holds no withdrawal permission. <code className="text-foreground">withdraw()</code>{" "}
        is <code className="text-foreground">onlyOwner</code> and reverts for the agent key.
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

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
