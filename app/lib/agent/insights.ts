import type {TickRecord} from "./loop";

/**
 * Derived read-only views over the tick history, for the dashboard.
 *
 * ## Why this exists
 *
 * The raw chart tells the truth but tells it badly. The bandit sweeps every arm at
 * the start of each epoch, and a sweep deliberately pulls arms it already has reason
 * to doubt — that is the cost of finding out. So for the first few ticks of every
 * market the agent is *supposed* to look mediocre, and against a fixed even split it
 * will often be behind. Then it exploits, and it pulls ahead.
 *
 * A judge glancing at the screen mid-sweep sees "the agent is losing". The honest fix
 * is not to hide the sweep or to cherry-pick the window — it is to label the phase and
 * to report the number that actually supports the claim: how the agent does *once it
 * has learned the market*. That number is {@link RunInsight.exploitEdgeBps}, and it is
 * computed here rather than in a component so it can be tested.
 *
 * Everything in this module is a pure function of the history array. No fetching, no
 * state, no clock.
 */

export interface RunInsight {
  /**
   * Indices where the epoch differs from the previous tick — the moments the market
   * was redrawn and the bandit's estimates were wiped. Drawn as reference lines so
   * the re-exploration after each one reads as a reset, not as a stumble.
   */
  readonly epochBoundaries: number[];

  /** Agent minus baseline at the newest tick, in MON. Null before the first tick. */
  readonly leadMon: number | null;

  /** The same lead relative to the baseline's book, in bps. */
  readonly leadBps: number | null;

  /**
   * Mean per-tick outperformance against the baseline, counting only returns earned
   * by an exploit decision. Null until at least one such return has landed.
   *
   * This is the defensible version of "the agent beats the baseline": it excludes the
   * exploration the agent pays for on purpose, and it is stated per tick rather than
   * cumulatively so a long run cannot flatter it.
   */
  readonly exploitEdgeBps: number | null;

  /** How many settled returns the edge above is averaged over. Shown next to it. */
  readonly exploitTicks: number;
}

/**
 * Computes every derived figure in one pass.
 *
 * ## The ordering trap, again
 *
 * `LeashVault.rebalance` settles under the **outgoing** weights, so `realisedBps` on
 * tick *i* is what the arm chosen on tick *i-1* earned — see the note at the top of
 * `loop.ts`. Attributing it to tick *i*'s own `reason` would silently mix explore
 * returns into the exploit average and inflate exactly the number the pitch rests on.
 * Hence `history[i - 1].reason` below, not `history[i].reason`.
 */
export function runInsight(history: readonly TickRecord[]): RunInsight {
  const epochBoundaries: number[] = [];
  let edgeTotal = 0;
  let exploitTicks = 0;

  for (let i = 1; i < history.length; i++) {
    const tick = history[i];
    const previous = history[i - 1];

    if (tick.epoch !== previous.epoch) epochBoundaries.push(i);

    // Only settled returns carry information; a rejected rebalance credits nothing.
    if (tick.realisedBps === null) continue;
    if (previous.reason !== "exploit") continue;

    // The baseline's own return over the same interval, from its book rather than
    // from the rates: it is the like-for-like comparison, and it stays correct even
    // on a tick where the rates could not be read.
    if (previous.baselineValue <= 0) continue;
    const baselineBps =
      ((tick.baselineValue - previous.baselineValue) / previous.baselineValue) * 10_000;

    edgeTotal += tick.realisedBps - baselineBps;
    exploitTicks += 1;
  }

  const latest = history.at(-1) ?? null;
  const leadMon = latest === null ? null : latest.agentValue - latest.baselineValue;
  const leadBps =
    latest === null || latest.baselineValue <= 0 ? null : (leadMon! / latest.baselineValue) * 10_000;

  return {
    epochBoundaries,
    leadMon,
    leadBps,
    exploitEdgeBps: exploitTicks === 0 ? null : edgeTotal / exploitTicks,
    exploitTicks,
  };
}

/**
 * What the agent is doing right now, for the phase badge.
 *
 * `converged` comes from the bandit (every arm has a reading) rather than being
 * re-derived from the history, so the badge cannot disagree with the arm panel.
 */
export function phaseOf(
  history: readonly TickRecord[],
  converged: boolean,
  running: boolean,
): "waiting" | "sweeping" | "exploiting" | "stopped" {
  if (history.length === 0) return "waiting";
  if (!running) return "stopped";
  return converged ? "exploiting" : "sweeping";
}
