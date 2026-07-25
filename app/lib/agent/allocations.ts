import {BPS_DENOMINATOR, MAX_WEIGHT_BPS, STRATEGY_COUNT} from "../chain/constants";

/**
 * The agent's action space.
 *
 * The bandit's arms are whole allocations, not individual strategies. That choice
 * is what keeps this an honest multi-armed bandit rather than a credit-assignment
 * problem wearing one as a costume: the vault settles a single blended return under
 * the outgoing weights, so a strategy-per-arm formulation would have to unmix
 * `Σ wᵢrᵢ` back into three unknowns from one scalar. Making the allocation itself
 * the arm means the reward is exactly the thing the arm produced, and the update is
 * the textbook one.
 *
 * The set is the six permutations of `[6000, 4000, 0]`. Given rates `r` and a 60%
 * cap, the return-maximising split is always "cap the best, remainder to the second
 * best, nothing to the worst" — so the optimum is guaranteed to be in the set, and
 * the set is small enough to sweep in six ticks.
 *
 * It also makes the leash visible. The agent's preferred move is 100% into the
 * winner; the contract will not let it past 6000 bps, so the best arm it can even
 * express is capped. That is worth pointing at during the demo.
 */

export interface Allocation {
  /** Stable identifier, used as the bandit's arm key and in the UI. */
  readonly id: string;
  /** Weights in basis points, one per strategy. Sums to BPS_DENOMINATOR. */
  readonly weights: readonly number[];
}

/** The remainder after the capped strategy takes its 6000 bps. */
const SECOND_BPS = BPS_DENOMINATOR - MAX_WEIGHT_BPS;

function permutations(): Allocation[] {
  const out: Allocation[] = [];
  for (let best = 0; best < STRATEGY_COUNT; best++) {
    for (let second = 0; second < STRATEGY_COUNT; second++) {
      if (second === best) continue;
      const weights = Array.from({length: STRATEGY_COUNT}, () => 0);
      weights[best] = MAX_WEIGHT_BPS;
      weights[second] = SECOND_BPS;
      out.push({id: `s${best}>s${second}`, weights});
    }
  }
  return out;
}

export const ALLOCATIONS: readonly Allocation[] = Object.freeze(permutations());

/**
 * The passive split the naive baseline holds. Deliberately *not* one of the arms —
 * it is the control the agent is measured against, and the contrast between "spread
 * evenly" and "concentrate on what is paying" is the whole race view.
 *
 * 10000 does not divide by 3, so the last strategy absorbs the remainder, matching
 * the vault constructor.
 */
export const EVEN_SPLIT: readonly number[] = (() => {
  const even = Math.floor(BPS_DENOMINATOR / STRATEGY_COUNT);
  const weights = Array.from({length: STRATEGY_COUNT}, () => even);
  weights[STRATEGY_COUNT - 1] = BPS_DENOMINATOR - even * (STRATEGY_COUNT - 1);
  return Object.freeze(weights);
})();

/**
 * The return an allocation would have earned against a known set of rates, in bps,
 * truncated exactly as `LeashVault._settle` truncates.
 *
 * Used by the baseline simulator and by the tests. The live agent never calls this
 * with the real rates — see the note in `bandit.ts` on why it must not.
 */
export function portfolioRateBps(weights: readonly number[], ratesBps: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i] * ratesBps[i];
  return Math.trunc(total / BPS_DENOMINATOR);
}
