import {parseEther} from "viem";
import {beforeEach, describe, expect, it} from "vitest";

import {MockAdapter} from "../chain/mockAdapter";
import {MONAD_BLOCK_TIME_MS, RATE_EPOCH_BLOCKS, REBALANCE_COOLDOWN_SECONDS} from "../chain/constants";
import {ALLOCATIONS, portfolioRateBps} from "./allocations";
import {AgentLoop} from "./loop";

/** Epoch 240000 pays -54 / +184 / -1, so strategy 1 is the one worth finding. */
const START_BLOCK = 240_000n * RATE_EPOCH_BLOCKS;

function fakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advanceSeconds(s: number) {
      now += s * 1000;
    },
    advanceBlocks(b: number) {
      now += b * MONAD_BLOCK_TIME_MS;
    },
  };
}

function harness(startBlock = START_BLOCK) {
  const clock = fakeClock();
  const adapter = new MockAdapter({
    now: clock.now,
    startBlock,
    principal: parseEther("100"),
  });
  // Always exploit, so the tests read the policy rather than the RNG.
  const loop = new AgentLoop(adapter, {random: () => 0.99});
  return {clock, adapter, loop};
}

/** One tick plus enough time for the on-chain cooldown to clear. */
async function tick(loop: AgentLoop, clock: ReturnType<typeof fakeClock>) {
  const record = await loop.tick();
  clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
  return record;
}

describe("reward attribution", () => {
  /**
   * The ordering trap, pinned. The vault settles under the *outgoing* weights, so
   * the value change seen across a rebalance belongs to the previous tick's arm.
   * Crediting it to the arm just chosen would still converge on something and still
   * draw a separating chart — it would just be meaningless.
   */
  it("credits the return to the arm that was actually exposed to it", async () => {
    const {clock, loop} = harness();

    const first = await tick(loop, clock);
    // Nothing to credit yet: no arm was holding the book before this tick.
    expect(first.realisedBps).toBeNull();
    expect(loop.bandit.stats().every((s) => s.pulls === 0)).toBe(true);

    const second = await tick(loop, clock);
    expect(second.realisedBps).not.toBeNull();

    const stats = loop.bandit.stats();
    const credited = stats.filter((s) => s.pulls > 0);
    expect(credited).toHaveLength(1);
    expect(credited[0].id).toBe(ALLOCATIONS[0].id);
    // Emphatically not the arm chosen on the second tick.
    expect(credited[0].id).not.toBe(ALLOCATIONS[1].id);
  });

  it("credits a return that matches what the public rates predict", async () => {
    const {clock, loop} = harness();

    await tick(loop, clock);
    const second = await tick(loop, clock);

    const expected = portfolioRateBps(ALLOCATIONS[0].weights, [-54, 184, -1]);
    expect(second.realisedBps).toBeCloseTo(expected, 6);
  });
});

describe("learning", () => {
  it("finds the best allocation and stays on it", async () => {
    const {clock, loop} = harness();

    // Sweep every arm, plus one tick to bank the last arm's reward.
    for (let i = 0; i <= ALLOCATIONS.length; i++) await tick(loop, clock);

    expect(loop.bandit.hasConverged()).toBe(true);

    const next = await tick(loop, clock);
    expect(next.reason).toBe("exploit");
    expect(next.weights).toEqual([0, 6000, 4000]);
    expect(next.rationale).toContain("s1");
  });

  it("beats the even-split baseline once it has converged", async () => {
    const {clock, loop} = harness();
    for (let i = 0; i < 20; i++) await tick(loop, clock);

    const last = loop.snapshot().history.at(-1);
    expect(last).toBeDefined();
    expect(last!.agentValue).toBeGreaterThan(last!.baselineValue);
  });

  it("re-explores when the epoch redraws the market", async () => {
    const {clock, loop} = harness();

    for (let i = 0; i <= ALLOCATIONS.length; i++) await tick(loop, clock);
    expect(loop.bandit.hasConverged()).toBe(true);

    // Jump the chain into the next epoch. Every rate is redrawn from a fresh block
    // hash, so everything learned above is now wrong rather than merely stale.
    clock.advanceBlocks(Number(RATE_EPOCH_BLOCKS));
    await tick(loop, clock);
    await tick(loop, clock);

    expect(loop.bandit.resetCount).toBeGreaterThan(0);
    expect(loop.bandit.hasConverged()).toBe(false);
    expect(loop.snapshot().history.at(-1)?.reason).toBe("sweep");
  });
});

describe("the loop under failure", () => {
  it("records a rejected rebalance without crediting anything", async () => {
    const {loop} = harness();
    // Deliberately no clock advance between the two, so the on-chain cooldown is
    // still live when the second one lands.
    await loop.tick();
    const before = loop.bandit.stats();
    const rejected = await loop.tick();

    expect(rejected.error).toMatch(/cooldown/);
    expect(rejected.txHash).toBeNull();
    expect(loop.bandit.stats()).toEqual(before);
  });

  it("stops itself once the breaker has tripped", async () => {
    // Epoch 5 pays -104 / -131 / -135: every strategy loses, so the book only falls
    // and the outcome does not depend on how the agent allocates.
    const {clock, loop} = harness(5n * RATE_EPOCH_BLOCKS);

    // Actually running, so "the breaker stopped it" is a real assertion rather than
    // a restatement of the initial state. Ticks below are driven by hand; the timer
    // start() schedules is 3s away and is cleared by the halt long before it fires.
    loop.start();
    expect(loop.isRunning).toBe(true);

    let last = await tick(loop, clock);
    for (let i = 0; i < 60 && !last.halted; i++) last = await tick(loop, clock);

    expect(last.halted).toBe(true);
    // Tripping stops the loop on the spot rather than a tick later.
    expect(loop.isRunning).toBe(false);

    // Any further tick declines to trade and says why.
    const afterHalt = await tick(loop, clock);
    expect(afterHalt.rationale).toContain("halted");
    expect(afterHalt.txHash).toBeNull();
  });
});

describe("the history the dashboard reads", () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness();
  });

  it("grows one record per tick and keeps them in order", async () => {
    const {clock, loop} = harnessed;
    for (let i = 0; i < 5; i++) await tick(loop, clock);

    const {history} = loop.snapshot();
    expect(history).toHaveLength(5);
    for (let i = 1; i < history.length; i++) {
      expect(history[i].at).toBeGreaterThanOrEqual(history[i - 1].at);
    }
  });

  it("caps history so a long run cannot grow without bound", async () => {
    const {clock, adapter} = harnessed;
    const loop = new AgentLoop(adapter, {random: () => 0.99, historyLimit: 3});
    for (let i = 0; i < 6; i++) await tick(loop, clock);
    expect(loop.snapshot().history).toHaveLength(3);
  });

  it("clears learning without touching the vault's book", async () => {
    const {clock, adapter, loop} = harnessed;
    for (let i = 0; i < 8; i++) await tick(loop, clock);

    const bookBefore = (await adapter.getState()).totalValue;
    loop.resetLearning();

    expect(loop.snapshot().history).toHaveLength(0);
    expect(loop.bandit.hasConverged()).toBe(false);
    expect((await adapter.getState()).totalValue).toBe(bookBefore);
  });
});

describe("the baseline against an unfunded vault", () => {
  /**
   * Both of these shipped broken once. A freshly deployed vault holds nothing until
   * the owner deposits, so the agent's first ticks read `totalValue: 0` — and the
   * baseline used to seed from that. `settle` is multiplicative, so a zero seed is
   * permanent: the race chart, which is the hero visual, silently loses its second
   * line and looks like a rendering fault rather than a seeding one.
   */
  function unfunded() {
    const clock = fakeClock();
    const adapter = new MockAdapter({
      now: clock.now,
      startBlock: START_BLOCK,
      principal: 0n,
    });
    return {clock, adapter, loop: new AgentLoop(adapter, {random: () => 0.99})};
  }

  it("does not seed the baseline from an empty vault", async () => {
    const {clock, adapter, loop} = unfunded();

    await tick(loop, clock);
    await tick(loop, clock);
    expect(loop.snapshot().history.at(-1)?.baselineValue).toBe(0);

    adapter.deposit(parseEther("100"));
    for (let i = 0; i < 4; i++) await tick(loop, clock);

    const last = loop.snapshot().history.at(-1);
    expect(last!.baselineValue).toBeGreaterThan(0);
    // The whole point: it tracks the market instead of being pinned to zero.
    expect(last!.baselineValue).not.toBe(100);
  });

  it("does not turn an owner deposit into a fake lead for the agent", async () => {
    // Cash flow is not performance. Doubling the book mid-run must move both lines,
    // or the agent appears to win by 100% for doing nothing.
    const {clock, adapter, loop} = unfunded();

    adapter.deposit(parseEther("100"));
    for (let i = 0; i < 3; i++) await tick(loop, clock);

    const before = loop.snapshot().history.at(-1)!;
    const gapBefore = before.agentValue / before.baselineValue;

    adapter.deposit(parseEther("100"));
    await tick(loop, clock);

    const after = loop.snapshot().history.at(-1)!;
    expect(after.agentValue).toBeGreaterThan(before.agentValue * 1.5);
    // The ratio between the two lines is what the chart reads as "who is winning".
    // A deposit must leave it alone.
    expect(after.agentValue / after.baselineValue).toBeCloseTo(gapBefore, 2);
  });
});
