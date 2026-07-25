import {describe, expect, it} from "vitest";

import type {TickRecord} from "./loop";
import {phaseOf, runInsight} from "./insights";

/** A tick with everything irrelevant to these assertions defaulted away. */
function tick(overrides: Partial<TickRecord> = {}): TickRecord {
  return {
    at: 0,
    epoch: "1",
    agentValue: 100,
    baselineValue: 100,
    weights: [],
    ratesBps: [],
    realisedBps: null,
    reason: "exploit",
    rationale: "",
    txHash: "0x1",
    gasUsed: "1",
    halted: false,
    error: null,
    ...overrides,
  };
}

describe("epoch boundaries", () => {
  it("marks the ticks where the market was redrawn", () => {
    const history = [
      tick({epoch: "1"}),
      tick({epoch: "1"}),
      tick({epoch: "2"}),
      tick({epoch: "2"}),
      tick({epoch: "3"}),
    ];
    expect(runInsight(history).epochBoundaries).toEqual([2, 4]);
  });

  it("reports none for a run inside a single epoch", () => {
    expect(runInsight([tick(), tick(), tick()]).epochBoundaries).toEqual([]);
  });

  it("reports none for an empty history", () => {
    expect(runInsight([]).epochBoundaries).toEqual([]);
  });
});

describe("the lead over the baseline", () => {
  it("is taken from the newest tick, not the best one", () => {
    // Reporting the high water mark instead would be the easy lie. The number on
    // screen must be the number right now.
    const history = [
      tick({agentValue: 130, baselineValue: 100}),
      tick({agentValue: 101, baselineValue: 100}),
    ];
    const insight = runInsight(history);
    expect(insight.leadMon).toBeCloseTo(1);
    expect(insight.leadBps).toBeCloseTo(100);
  });

  it("goes negative when the agent is behind", () => {
    const insight = runInsight([tick({agentValue: 99, baselineValue: 100})]);
    expect(insight.leadMon).toBeCloseTo(-1);
    expect(insight.leadBps).toBeCloseTo(-100);
  });

  it("is null before the first tick", () => {
    const insight = runInsight([]);
    expect(insight.leadMon).toBeNull();
    expect(insight.leadBps).toBeNull();
  });
});

describe("the exploit-phase edge", () => {
  it("credits a realised return to the decision that earned it, not the one beside it", () => {
    // The ordering trap. The vault settles under the OUTGOING weights, so the return
    // arriving on tick 1 belongs to the arm chosen on tick 0. Tick 0 explored, so
    // this return must NOT count toward the exploit average even though tick 1 is
    // itself an exploit. Getting this backwards inflates the headline number.
    const history = [
      tick({reason: "explore", baselineValue: 100}),
      tick({reason: "exploit", realisedBps: 500, baselineValue: 100}),
    ];
    const insight = runInsight(history);
    expect(insight.exploitTicks).toBe(0);
    expect(insight.exploitEdgeBps).toBeNull();
  });

  it("counts a return whose preceding decision was an exploit", () => {
    const history = [
      tick({reason: "exploit", baselineValue: 100}),
      tick({reason: "explore", realisedBps: 120, baselineValue: 101}),
    ];
    const insight = runInsight(history);
    expect(insight.exploitTicks).toBe(1);
    // Agent earned 120 bps; the baseline's book moved 100 -> 101, i.e. 100 bps.
    expect(insight.exploitEdgeBps).toBeCloseTo(20);
  });

  it("averages per tick rather than accumulating", () => {
    // A cumulative figure would grow with runtime alone and would say nothing about
    // whether the policy is any good.
    const history = [
      tick({reason: "exploit", baselineValue: 100}),
      tick({reason: "exploit", realisedBps: 200, baselineValue: 100}),
      tick({reason: "exploit", realisedBps: 100, baselineValue: 100}),
    ];
    expect(runInsight(history).exploitEdgeBps).toBeCloseTo(150);
    expect(runInsight(history).exploitTicks).toBe(2);
  });

  it("can be negative, and is not clamped", () => {
    const history = [
      tick({reason: "exploit", baselineValue: 100}),
      tick({reason: "exploit", realisedBps: -50, baselineValue: 100}),
    ];
    expect(runInsight(history).exploitEdgeBps).toBeCloseTo(-50);
  });

  it("skips ticks where nothing settled", () => {
    const history = [
      tick({reason: "exploit", baselineValue: 100}),
      tick({reason: "exploit", realisedBps: null, baselineValue: 100}),
    ];
    expect(runInsight(history).exploitTicks).toBe(0);
  });

  it("skips a tick whose baseline book is empty, rather than dividing by zero", () => {
    const history = [
      tick({reason: "exploit", baselineValue: 0}),
      tick({reason: "exploit", realisedBps: 100, baselineValue: 0}),
    ];
    const insight = runInsight(history);
    expect(insight.exploitTicks).toBe(0);
    expect(insight.exploitEdgeBps).toBeNull();
  });
});

describe("the phase badge", () => {
  it("waits before any history exists", () => {
    expect(phaseOf([], false, true)).toBe("waiting");
  });

  it("reports stopped even when the bandit has converged", () => {
    expect(phaseOf([tick()], true, false)).toBe("stopped");
  });

  it("sweeps until every arm has a reading", () => {
    expect(phaseOf([tick()], false, true)).toBe("sweeping");
  });

  it("exploits once the bandit says it has converged", () => {
    expect(phaseOf([tick()], true, true)).toBe("exploiting");
  });
});
