import {describe, expect, it} from "vitest";

import {BPS_DENOMINATOR, MAX_WEIGHT_BPS, STRATEGY_COUNT} from "../chain/constants";
import {ALLOCATIONS, EVEN_SPLIT, portfolioRateBps} from "./allocations";
import {Bandit} from "./bandit";

/** A deterministic RNG so "explore" and "exploit" are testable, not flaky. */
function fixedRandom(...values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("the action space", () => {
  it("only contains allocations the contract will accept", () => {
    // The bandit proposing something the vault rejects would burn a transaction per
    // tick. Cheaper to prove it cannot happen than to catch it on stage.
    for (const {id, weights} of ALLOCATIONS) {
      expect(weights, id).toHaveLength(STRATEGY_COUNT);
      expect(weights.reduce((a, b) => a + b, 0), id).toBe(BPS_DENOMINATOR);
      for (const w of weights) {
        expect(w, id).toBeGreaterThanOrEqual(0);
        expect(w, id).toBeLessThanOrEqual(MAX_WEIGHT_BPS);
        expect(Number.isInteger(w), id).toBe(true);
      }
    }
  });

  it("covers every ordered pair of strategies exactly once", () => {
    expect(ALLOCATIONS).toHaveLength(STRATEGY_COUNT * (STRATEGY_COUNT - 1));
    expect(new Set(ALLOCATIONS.map((a) => a.id)).size).toBe(ALLOCATIONS.length);
  });

  it("contains the return-maximising allocation for any rates", () => {
    // The whole reason for this arm set: with a 60% cap, "cap the best, remainder to
    // the second best" is optimal, so the bandit's ceiling is the true optimum.
    const rates = [-54, 184, -1];
    const best = ALLOCATIONS.map((a) => portfolioRateBps(a.weights, rates)).reduce((a, b) =>
      Math.max(a, b),
    );
    expect(portfolioRateBps([0, MAX_WEIGHT_BPS, 4000], rates)).toBe(best);
    expect(best).toBeGreaterThan(portfolioRateBps(EVEN_SPLIT, rates));
  });

  it("truncates the weighted return exactly as the vault does", () => {
    // 4000*-54 + 6000*184 = 888000; /10000 = 88.8, and Solidity truncates to 88.
    expect(portfolioRateBps([4000, 6000, 0], [-54, 184, -1])).toBe(88);
    // Truncation is toward zero on the negative side too, matching Solidity.
    expect(portfolioRateBps([6000, 4000, 0], [-54, -1, 184])).toBe(-32);
  });
});

describe("the bandit", () => {
  it("tries every arm before it exploits anything", () => {
    // Plain epsilon-greedy leaves the sweep to chance, which is fine over ten
    // thousand pulls and useless when the whole epoch is twenty ticks.
    const bandit = new Bandit({random: () => 0.99});
    const seen = new Set<string>();

    for (let i = 0; i < ALLOCATIONS.length; i++) {
      const {allocation, reason} = bandit.select();
      expect(reason).toBe("sweep");
      seen.add(allocation.id);
      bandit.observe(1n, allocation.id, 0);
    }

    expect(seen.size).toBe(ALLOCATIONS.length);
    expect(bandit.hasConverged()).toBe(true);
    expect(bandit.select().reason).not.toBe("sweep");
  });

  it("settles on the arm with the best realised return", () => {
    const bandit = new Bandit({random: () => 0.99});
    const rates = [-54, 184, -1];

    for (const arm of ALLOCATIONS) {
      bandit.observe(1n, arm.id, portfolioRateBps(arm.weights, rates));
    }

    const {allocation, reason} = bandit.select();
    expect(reason).toBe("exploit");
    expect(allocation.id).toBe("s1>s2");
    expect(allocation.weights).toEqual([0, 6000, 4000]);
  });

  it("explores when the draw falls under epsilon", () => {
    const bandit = new Bandit({epsilon: 0.2, random: fixedRandom(0.05, 0)});
    for (const arm of ALLOCATIONS) bandit.observe(1n, arm.id, 0);
    expect(bandit.select().reason).toBe("explore");
  });

  it("forgets everything when the epoch turns over", () => {
    // Rates are redrawn from a fresh block hash each epoch, independently of the
    // last. Estimates carried across that boundary are wrong, not merely stale.
    const bandit = new Bandit({random: () => 0.99});
    for (const arm of ALLOCATIONS) bandit.observe(1n, arm.id, 100);
    expect(bandit.hasConverged()).toBe(true);

    bandit.observe(2n, ALLOCATIONS[0].id, -50);

    expect(bandit.resetCount).toBe(1);
    expect(bandit.hasConverged()).toBe(false);
    expect(bandit.select().reason).toBe("sweep");
    expect(bandit.stats().find((s) => s.id === ALLOCATIONS[0].id)?.meanRewardBps).toBe(-50);
  });

  it("never reports an estimate for an arm it has not pulled", () => {
    // A zero here would read as "tried it, it paid nothing" and could suppress the
    // sweep. Null is the honest answer.
    const stats = new Bandit().stats();
    expect(stats).toHaveLength(ALLOCATIONS.length);
    for (const s of stats) {
      expect(s.meanRewardBps).toBeNull();
      expect(s.pulls).toBe(0);
    }
  });

  it("ignores a reward credited to an arm it does not have", () => {
    const bandit = new Bandit();
    bandit.observe(1n, "not-an-arm", 500);
    expect(bandit.stats().every((s) => s.pulls === 0)).toBe(true);
  });
});
