"use client";

import type {ArmStats} from "../../lib/agent/bandit";
import {Badge} from "./primitives";

/**
 * What the bandit currently believes, per arm.
 *
 * Arms are whole allocations rather than single strategies — the vault settles one
 * blended return under the outgoing weights, so a strategy-per-arm formulation would
 * have to unmix three unknowns from one scalar. `s1>s0` reads as "60% into strategy
 * 1, the remaining 40% into strategy 0".
 *
 * Untried arms show a dash, never a zero. A zero would read as "tried it, it paid
 * nothing", which is a different and false claim.
 */
export function ArmScores({
  arms,
  converged,
  resets,
}: {
  arms: ArmStats[];
  converged: boolean;
  resets: number;
}) {
  const best = arms.reduce<ArmStats | null>((acc, arm) => {
    if (arm.meanRewardBps === null) return acc;
    if (acc === null || acc.meanRewardBps === null) return arm;
    return arm.meanRewardBps > acc.meanRewardBps ? arm : acc;
  }, null);

  const magnitude = Math.max(...arms.map((a) => Math.abs(a.meanRewardBps ?? 0)), 1);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge tone={converged ? "agent" : "warn"} dot>
          {converged ? "exploiting" : "exploring"}
        </Badge>
        <span className="text-[11px] text-muted-dim">
          {resets} market{resets === 1 ? "" : "s"} learned since start
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {arms.map((arm) => {
          const mean = arm.meanRewardBps;
          const isBest = best !== null && arm.id === best.id;
          const width = mean === null ? 0 : (Math.abs(mean) / magnitude) * 100;

          return (
            <li
              key={arm.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-raised"
            >
              <span
                className={`mono w-16 shrink-0 text-[13px] ${
                  isBest ? "text-agent" : "text-muted"
                }`}
              >
                {arm.id}
              </span>

              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised">
                <div
                  className={`absolute inset-y-0 rounded-full transition-[width] duration-500 ${
                    mean === null ? "" : mean >= 0 ? "bg-gain" : "bg-loss"
                  }`}
                  style={{width: `${width}%`, opacity: isBest ? 1 : 0.4}}
                />
              </div>

              <span
                className={`mono w-14 shrink-0 text-right text-[13px] font-medium ${
                  mean === null ? "text-muted-dim" : mean >= 0 ? "text-gain" : "text-loss"
                }`}
              >
                {mean === null ? "—" : mean.toFixed(0)}
              </span>
              <span className="mono w-14 shrink-0 text-right text-[11px] text-muted-dim">
                {arm.pulls} {arm.pulls === 1 ? "pull" : "pulls"}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-auto text-[11px] leading-relaxed text-muted-dim">
        Epsilon-greedy multi-armed bandit, reset at every epoch boundary — each epoch redraws the
        market from a fresh block hash, so estimates carried across it would be wrong, not stale.
      </p>
    </div>
  );
}
