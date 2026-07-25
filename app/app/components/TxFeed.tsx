"use client";

import type {TickRecord} from "../../lib/agent/loop";
import {explorerTxUrl} from "../../lib/chain/constants";
import {formatBps} from "./primitives";

/**
 * Every decision the agent has made, newest first.
 *
 * Each row is one `Rebalanced` event: the allocation, why it was chosen, what it
 * paid, and the transaction. A judge will click one of these, so on the mock the
 * hash is rendered as plain text rather than as a link to an explorer page that
 * would 404 — a dead link on stage costs more than a missing one.
 *
 * The rationale shown here is the preimage of the `rationaleHash` that went on-chain.
 * That is what makes the hash mean something: anyone holding this text can verify it
 * against the event.
 */
export function TxFeed({history, live}: {history: TickRecord[]; live: boolean}) {
  const rows = [...history].reverse().slice(0, 40);

  if (rows.length === 0) {
    return <div className="py-8 text-center text-muted">No transactions yet.</div>;
  }

  return (
    <ul className="flex max-h-96 flex-col divide-y divide-border-subtle overflow-y-auto">
      {rows.map((tick, i) => (
        <li key={`${tick.at}-${i}`} className="flex items-start gap-4 py-3">
          <span
            className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
              tick.error ? "bg-loss" : tick.reason === "exploit" ? "bg-agent" : "bg-warn"
            }`}
            aria-hidden
          />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="tabular text-sm font-bold">
                {tick.weights.map((w) => `${Math.round(w / 100)}%`).join(" / ")}
              </span>
              <span className="text-xs uppercase tracking-widest text-muted">{tick.reason}</span>
              {tick.realisedBps !== null ? (
                <span
                  className={`tabular text-sm font-semibold ${
                    tick.realisedBps >= 0 ? "text-gain" : "text-loss"
                  }`}
                >
                  {formatBps(tick.realisedBps)}
                </span>
              ) : null}
            </div>

            <p className="mt-0.5 truncate text-xs text-muted" title={tick.rationale}>
              {tick.rationale}
            </p>

            {tick.error ? <p className="mt-0.5 text-xs text-loss">{tick.error}</p> : null}
          </div>

          <div className="shrink-0 text-right">
            {tick.txHash === null ? (
              <span className="text-xs text-muted">no tx</span>
            ) : live ? (
              <a
                href={explorerTxUrl(tick.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="tabular text-xs font-semibold text-agent underline decoration-agent/40 underline-offset-2 hover:decoration-agent"
              >
                {short(tick.txHash)}
              </a>
            ) : (
              <span className="tabular text-xs text-muted" title="simulated — no explorer page">
                {short(tick.txHash)}
              </span>
            )}
            {tick.gasUsed ? (
              <div className="tabular mt-0.5 text-xs text-muted">
                {Number(tick.gasUsed).toLocaleString()} gas
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function short(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
