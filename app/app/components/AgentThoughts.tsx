"use client";

import type {TickRecord} from "../../lib/agent/loop";
import {formatBps} from "./primitives";

/**
 * "What the agent is thinking" — a narrative reading of the same history TxFeed shows
 * as a table. Deliberately not a duplicate: TxFeed is the record for someone auditing
 * every decision; this is the one glanced at from across the room. Every line is a
 * real field off `TickRecord` — the rationale text whose hash actually went on-chain,
 * the real weights, the real realised return — nothing here is invented for the sake
 * of matching a mock-up's "confidence 82%".
 */
export function AgentThoughts({history, running}: {history: TickRecord[]; running: boolean}) {
  const rows = [...history].reverse().slice(0, 6);

  if (rows.length === 0) {
    return <div className="py-8 text-center text-muted">Waiting on the first tick.</div>;
  }

  return (
    <ol className="relative flex flex-col gap-5 pl-5">
      <span className="absolute bottom-1 left-[3px] top-1 w-px bg-border-subtle" aria-hidden />

      {rows.map((tick, i) => (
        <li key={`${tick.at}-${i}`} className="relative">
          <span
            className={`absolute -left-5 top-1 h-1.5 w-1.5 rounded-full ${
              tick.error ? "bg-loss" : tick.reason === "exploit" ? "bg-agent" : "bg-warn"
            }`}
            aria-hidden
          />

          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="mono text-[11px] text-muted-dim">{time(tick.at)}</span>
            <span className="text-[10px] uppercase tracking-[0.14em] text-muted-dim">{tick.reason}</span>
          </div>

          <p className="mt-1 text-[13px] leading-snug text-foreground">{tick.rationale}</p>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-dim">
            <span className="mono">
              → {tick.weights.map((w) => `${Math.round(w / 100)}%`).join(" / ")}
            </span>
            {tick.realisedBps !== null ? (
              <span className={`mono ${tick.realisedBps >= 0 ? "text-gain" : "text-loss"}`}>
                earned {formatBps(tick.realisedBps)}
              </span>
            ) : i === 0 && running && !tick.halted ? (
              <span className="text-warn">executing…</span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit"});
}
