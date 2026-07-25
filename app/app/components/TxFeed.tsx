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
    <ul className="thin-scroll flex max-h-[22rem] flex-col divide-y divide-border-subtle overflow-y-auto">
      {rows.map((tick, i) => (
        <li
          key={`${tick.at}-${i}`}
          className="flex items-start gap-4 px-2 py-2.5 transition-colors hover:bg-surface-raised"
        >
          <span
            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
              tick.error ? "bg-loss" : tick.reason === "exploit" ? "bg-agent" : "bg-warn"
            }`}
            aria-hidden
          />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="mono text-[13px] font-medium">
                {tick.weights.map((w) => `${Math.round(w / 100)}%`).join(" / ")}
              </span>
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-dim">
                {tick.reason}
              </span>
              {tick.realisedBps !== null ? (
                <span
                  className={`mono text-[13px] font-medium ${
                    tick.realisedBps >= 0 ? "text-gain" : "text-loss"
                  }`}
                >
                  {formatBps(tick.realisedBps)}
                </span>
              ) : null}
            </div>

            <p className="mt-0.5 truncate text-[11px] text-muted-dim" title={tick.rationale}>
              {tick.rationale}
            </p>

            {tick.error ? <p className="mt-0.5 text-[11px] text-loss">{tick.error}</p> : null}
          </div>

          <div className="shrink-0 text-right">
            {tick.txHash === null ? (
              <span className="text-[11px] text-muted-dim">no tx</span>
            ) : live ? (
              <a
                href={explorerTxUrl(tick.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="mono text-[11px] text-agent underline decoration-agent/30 underline-offset-4 hover:decoration-agent"
              >
                {short(tick.txHash)}
              </a>
            ) : (
              <span className="mono text-[11px] text-muted-dim" title="simulated — no explorer page">
                {short(tick.txHash)}
              </span>
            )}
            {tick.gasUsed ? (
              <div className="mono mt-0.5 text-[10px] text-muted-dim">
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
