import {parseEther} from "viem";
import {beforeEach, describe, expect, it} from "vitest";

import {ChainAdapter, rationaleHash, RebalanceRejected} from "./adapter";
import {MockAdapter} from "./mockAdapter";
import {
  MAX_DRAWDOWN_BPS,
  MAX_WEIGHT_BPS,
  MONAD_BLOCK_TIME_MS,
  RATE_EPOCH_BLOCKS,
  REBALANCE_COOLDOWN_SECONDS,
  TICK_INTERVAL_MS,
} from "./constants";

/**
 * The mock is only useful if it behaves like the contract. These tests hold it to
 * the same guarantees the Foundry suite holds LeashVault to, plus a fixture check
 * that the rate derivation matches Foundry's own keccak rather than just matching
 * itself.
 */

const HASH = rationaleHash("momentum favours strategy 1");
const EVEN: number[] = [3333, 3333, 3334];

/** A clock the test drives by hand, so nothing depends on wall time. */
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

describe("rate derivation", () => {
  /**
   * Generated with Foundry's own implementation, not with viem:
   *   cast keccak $(cast abi-encode "f(uint256,uint256)" <epoch> <id>)  mod 401 - 200
   * If the two ever disagree about abi.encode or keccak, this catches it.
   */
  const fixtures = [
    {epoch: 0n, id: 0, rate: -14n},
    {epoch: 0n, id: 1, rate: -68n},
    {epoch: 0n, id: 2, rate: -138n},
    {epoch: 1n, id: 0, rate: -157n},
    {epoch: 1n, id: 1, rate: -153n},
    {epoch: 1n, id: 2, rate: -167n},
    {epoch: 14n, id: 0, rate: 143n},
    {epoch: 137n, id: 1, rate: -143n},
    {epoch: 1000n, id: 0, rate: 86n},
  ];

  it.each(fixtures)("matches Foundry for epoch $epoch, strategy $id", ({epoch, id, rate}) => {
    expect(new MockAdapter().rateAtEpoch(epoch, id)).toBe(rate);
  });

  it("stays inside the declared bound", () => {
    const adapter = new MockAdapter();
    for (let epoch = 0n; epoch < 500n; epoch++) {
      for (let id = 0; id < 3; id++) {
        const rate = adapter.rateAtEpoch(epoch, id);
        expect(rate).toBeGreaterThanOrEqual(-200n);
        expect(rate).toBeLessThanOrEqual(200n);
      }
    }
  });

  it("holds a rate for a whole epoch and redraws after it", () => {
    const adapter = new MockAdapter();

    expect(adapter.strategyRateBps(0, 0n)).toBe(-14n);
    expect(adapter.strategyRateBps(0, RATE_EPOCH_BLOCKS - 1n)).toBe(-14n);
    expect(adapter.strategyRateBps(0, RATE_EPOCH_BLOCKS)).toBe(-157n);
  });
});

describe("guardrails", () => {
  let clock: ReturnType<typeof fakeClock>;
  let adapter: MockAdapter;

  beforeEach(() => {
    clock = fakeClock();
    adapter = new MockAdapter({now: clock.now});
  });

  it("rejects a weight above the cap", async () => {
    await expect(adapter.rebalance([MAX_WEIGHT_BPS + 1, 2000, 1999], HASH)).rejects.toThrow(
      RebalanceRejected,
    );
  });

  it("accepts a weight exactly at the cap", async () => {
    await adapter.rebalance([MAX_WEIGHT_BPS, 2000, 2000], HASH);
    expect((await adapter.getState()).weights).toEqual([MAX_WEIGHT_BPS, 2000, 2000]);
  });

  it("rejects weights that do not sum to 10000", async () => {
    await expect(adapter.rebalance([3000, 3000, 3000], HASH)).rejects.toThrow(/sum to 9000/);
  });

  it("rejects the wrong number of weights", async () => {
    await expect(adapter.rebalance([5000, 5000], HASH)).rejects.toThrow(/expected 3 weights/);
  });

  it("rejects a rebalance inside the cooldown and allows it after", async () => {
    await adapter.rebalance([5000, 3000, 2000], HASH);

    await expect(adapter.rebalance([2000, 3000, 5000], HASH)).rejects.toThrow(/cooldown/);

    clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
    await adapter.rebalance([2000, 3000, 5000], HASH);
    expect((await adapter.getState()).weights).toEqual([2000, 3000, 5000]);
  });

  it("keeps the tick interval clear of the cooldown", () => {
    // Guards the single most common way to make half the transactions revert.
    expect(TICK_INTERVAL_MS).toBeGreaterThan(REBALANCE_COOLDOWN_SECONDS * 1000);
  });
});

describe("settlement", () => {
  it("moves value only when the agent acts, never with time alone", async () => {
    const clock = fakeClock();
    const adapter = new MockAdapter({now: clock.now});

    const before = (await adapter.getState()).totalValue;
    clock.advanceBlocks(5_000);
    expect((await adapter.getState()).totalValue).toBe(before);

    await adapter.rebalance(EVEN, HASH);
    expect((await adapter.getState()).totalValue).not.toBe(before);
  });

  it("applies exactly the weighted return the public rates predict", async () => {
    const clock = fakeClock();
    // Epoch 14 pays 143/164/153 bps, so the book should rise.
    const adapter = new MockAdapter({
      now: clock.now,
      startBlock: 14n * RATE_EPOCH_BLOCKS,
      principal: parseEther("100"),
    });

    // Recomputed here rather than read back, so the test does not simply agree
    // with the implementation it is checking.
    const rates = [0, 1, 2].map((i) => adapter.rateAtEpoch(14n, i));
    const weights = [3333n, 3333n, 3334n];
    let portfolioRateBps = 0n;
    for (let i = 0; i < 3; i++) portfolioRateBps += weights[i] * rates[i];
    portfolioRateBps /= 10_000n;

    const before = parseEther("100");
    const expected = before + (before * portfolioRateBps) / 10_000n;

    await adapter.rebalance(EVEN, HASH);

    // Compared in wei, not in floats: the point is that the integer arithmetic
    // matches, and rounding through a double would hide exactly the drift we care
    // about catching.
    expect(adapter.bookValueWei()).toBe(expected);
    expect(expected).toBeGreaterThan(before);
  });
});

describe("the drawdown breaker", () => {
  /**
   * Epoch 1 pays -157/-153/-167 bps, so every strategy loses and the outcome does
   * not depend on how the book is allocated. Ticking at the cooldown advances about
   * seven blocks a time, so the run stays inside the epoch.
   */
  const ADVERSE_START_BLOCK = 1n * RATE_EPOCH_BLOCKS;

  function adverseAdapter() {
    const clock = fakeClock();
    const adapter = new MockAdapter({
      now: clock.now,
      startBlock: ADVERSE_START_BLOCK,
      principal: parseEther("100"),
    });
    return {clock, adapter};
  }

  it("halts itself once the drawdown passes 15%", async () => {
    const {clock, adapter} = adverseAdapter();
    expect((await adapter.getState()).halted).toBe(false);

    let ticks = 0;
    while (!(await adapter.getState()).halted && ticks < 50) {
      await adapter.rebalance(EVEN, HASH);
      clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
      ticks++;
    }

    expect(ticks).toBeLessThan(50);
    expect(adapter.blockNumber() / RATE_EPOCH_BLOCKS).toBe(1n);
    expect((await adapter.getState()).halted).toBe(true);
    expect(adapter.drawdownBps()).toBeGreaterThan(BigInt(MAX_DRAWDOWN_BPS));
  });

  it("locks the agent out after tripping", async () => {
    const {clock, adapter} = adverseAdapter();

    for (let i = 0; i < 50 && !(await adapter.getState()).halted; i++) {
      await adapter.rebalance(EVEN, HASH);
      clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
    }

    clock.advanceSeconds(3_600);
    await expect(adapter.rebalance(EVEN, HASH)).rejects.toThrow(/halted/);
  });

  it("does not apply the allocation on the tick that trips it", async () => {
    const {clock, adapter} = adverseAdapter();

    let last = EVEN;
    for (let i = 0; i < 50 && !(await adapter.getState()).halted; i++) {
      // Alternate so the final, rejected allocation is distinguishable.
      last = i % 2 === 0 ? [6000, 2000, 2000] : [2000, 2000, 6000];
      await adapter.rebalance(last, HASH);
      clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
    }

    expect((await adapter.getState()).halted).toBe(true);
    expect((await adapter.getState()).weights).not.toEqual(last);
  });

  it("keeps the drawdown unchanged across a deposit", async () => {
    const {clock, adapter} = adverseAdapter();

    await adapter.rebalance(EVEN, HASH);
    clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);

    const before = adapter.drawdownBps();
    expect(before).toBeGreaterThan(0n);

    adapter.deposit(parseEther("50"));

    // Moving capital must not mask a drawdown or manufacture one. Integer
    // arithmetic can move the ratio by a bp.
    const after = adapter.drawdownBps();
    expect(after >= before - 1n && after <= before + 1n).toBe(true);
  });
});

describe("stats", () => {
  it("counts only transactions that actually went through", async () => {
    const clock = fakeClock();
    const adapter = new MockAdapter({now: clock.now});

    expect(await adapter.getStats()).toEqual({txCount: 0, totalGas: 0n});

    await adapter.rebalance([5000, 3000, 2000], HASH);
    await expect(adapter.rebalance([9999, 1, 0], HASH)).rejects.toThrow();

    clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
    await adapter.rebalance([2000, 3000, 5000], HASH);

    const stats = await adapter.getStats();
    expect(stats.txCount).toBe(2);
    expect(stats.totalGas).toBe(94_702n * 2n);
  });

  it("returns a distinct hash per transaction", async () => {
    const clock = fakeClock();
    const adapter = new MockAdapter({now: clock.now});

    const first = await adapter.rebalance([5000, 3000, 2000], HASH);
    clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
    const second = await adapter.rebalance([2000, 3000, 5000], HASH);

    expect(first.txHash).not.toBe(second.txHash);
    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("the seam", () => {
  it("reports mock identity so the dashboard can suppress explorer links", () => {
    expect(new MockAdapter().isMock).toBe(true);
  });

  it("satisfies the ChainAdapter interface", async () => {
    const adapter: ChainAdapter = new MockAdapter();
    const state = await adapter.getState();

    expect(state.weights).toHaveLength(3);
    expect(typeof state.totalValue).toBe("number");
    expect(typeof state.halted).toBe("boolean");
    expect(state.rates).toHaveLength(3);
  });
});
