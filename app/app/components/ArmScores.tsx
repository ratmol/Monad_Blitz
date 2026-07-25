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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={converged ? "gain" : "warn"}>
          {converged ? "exploiting" : "exploring"}
        </Badge>
        <span className="text-xs text-muted">
          {resets} market{resets === 1 ? "" : "s"} learned since start
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {arms.map((arm) => {
          const mean = arm.meanRewardBps;
          const isBest = best !== null && arm.id === best.id;
          const width = mean === null ? 0 : (Math.abs(mean) / magnitude) * 100;

          return (
            <li key={arm.id} className="flex items-center gap-3">
              <span
                className={`tabular w-20 shrink-0 text-sm font-bold ${
                  isBest ? "text-agent" : "text-muted"
                }`}
              >
                {arm.id}
              </span>

              <div className="relative h-6 flex-1 overflow-hidden rounded bg-background">
                <div
                  className={`absolute inset-y-0 rounded transition-[width] duration-500 ${
                    mean === null ? "" : mean >= 0 ? "bg-gain" : "bg-loss"
                  }`}
                  style={{width: `${width}%`, opacity: isBest ? 1 : 0.45}}
                />
              </div>

              <span className="tabular w-24 shrink-0 text-right text-sm font-bold">
                {mean === null ? <span className="text-muted">—</span> : mean.toFixed(0)}
              </span>
              <span className="tabular w-16 shrink-0 text-right text-xs text-muted">
                {arm.pulls} {arm.pulls === 1 ? "pull" : "pulls"}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted">
        Epsilon-greedy multi-armed bandit, reset at every epoch boundary — each epoch redraws the
        market from a fresh block hash, so estimates carried across it would be wrong, not stale.
      </p>
    </div>
  );
}
