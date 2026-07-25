import {parseEther} from "viem";
import {beforeEach, describe, expect, it} from "vitest";

import {ChainAdapter, EpochNotAnchored, rationaleHash, RebalanceRejected} from "./adapter";
import {MockAdapter} from "./mockAdapter";
import {
  BLOCKHASH_WINDOW_BLOCKS,
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
   *   cast keccak $(cast abi-encode "f(bytes32,uint256)" <anchor> <id>)  mod 401 - 200
   * If the two ever disagree about abi.encode or keccak, this catches it. Keeping
   * Foundry as the fixture source is the whole point: it is what makes the mock
   * cross-checked against the contract rather than merely self-consistent.
   *
   * The anchors are the ones the mock actually produces for the epochs used below,
   * plus two degenerate bytes32 values to pin the encoding at the edges.
   */
  const ANCHOR_EPOCH_5 = "0xf2b4e536bd23bd6782833c997983bc4a576dc5faca807b4000f207eec069ebd4";
  const ANCHOR_EPOCH_81 = "0xde3dfdc2e9c20d78f3c60fb050865f2d267d2b2e543fd782458045042cd43905";
  const ANCHOR_DEFAULT = "0x5f1ce7ee2164c9aed88bd05adf77f0b3c7f8164d454f1a9407867338dbb6641e";

  const fixtures = [
    {anchor: ANCHOR_EPOCH_5, id: 0, rate: -104n},
    {anchor: ANCHOR_EPOCH_5, id: 1, rate: -131n},
    {anchor: ANCHOR_EPOCH_5, id: 2, rate: -135n},
    {anchor: ANCHOR_EPOCH_81, id: 0, rate: 129n},
    {anchor: ANCHOR_EPOCH_81, id: 1, rate: 160n},
    {anchor: ANCHOR_EPOCH_81, id: 2, rate: 121n},
    {anchor: ANCHOR_DEFAULT, id: 0, rate: -54n},
    {anchor: ANCHOR_DEFAULT, id: 1, rate: 184n},
    {anchor: ANCHOR_DEFAULT, id: 2, rate: -1n},
    {anchor: `0x${"00".repeat(31)}01`, id: 0, rate: -157n},
    {anchor: `0x${"ff".repeat(32)}`, id: 1, rate: 167n},
  ] as const;

  it.each(fixtures)("matches Foundry for anchor $anchor, strategy $id", ({anchor, id, rate}) => {
    expect(new MockAdapter().rateFromAnchor(anchor, id)).toBe(rate);
  });

  it("derives the anchors the fixtures assume", () => {
    // Ties the fixture table to the mock's own synthetic-blockhash scheme, so a
    // change to that scheme fails loudly here instead of silently invalidating
    // every rate above.
    const at = 5n * RATE_EPOCH_BLOCKS;
    expect(new MockAdapter({startBlock: at}).epochAnchor(5n, at)).toBe(ANCHOR_EPOCH_5);
  });

  it("stays inside the declared bound", () => {
    const adapter = new MockAdapter();
    for (let block = RATE_EPOCH_BLOCKS; block < 500n * RATE_EPOCH_BLOCKS; block += 997n) {
      const anchor = adapter.epochAnchor(block / RATE_EPOCH_BLOCKS, block);
      for (let id = 0; id < 3; id++) {
        const rate = adapter.rateFromAnchor(anchor, id);
        expect(rate).toBeGreaterThanOrEqual(-200n);
        expect(rate).toBeLessThanOrEqual(200n);
      }
    }
  });

  it("holds a rate for a whole epoch and redraws after it", () => {
    const start = 240_000n * RATE_EPOCH_BLOCKS;
    const adapter = new MockAdapter({startBlock: start});

    // Epoch 240000 pays -54/184/-1; the next epoch pays -73/186/197.
    expect(adapter.strategyRateBps(0, start)).toBe(-54n);
    expect(adapter.strategyRateBps(0, start + RATE_EPOCH_BLOCKS - 1n)).toBe(-54n);
    expect(adapter.strategyRateBps(0, start + RATE_EPOCH_BLOCKS)).toBe(-73n);
  });
});

describe("epoch anchoring", () => {
  /**
   * The property Adarsha's `d8f41d3` bought, and the reason the fixtures above had
   * to be regenerated. Before it, `rateAtEpoch` was pure in the epoch number and
   * every future market was computable today — an agent could have solved the game
   * rather than learned it.
   */
  it("refuses to price an epoch that has not started", () => {
    const start = 240_000n * RATE_EPOCH_BLOCKS;
    const adapter = new MockAdapter({startBlock: start});

    expect(() => adapter.rateAtEpoch(240_001n, 0, start)).toThrow(EpochNotAnchored);
    expect(() => adapter.rateAtEpoch(999_999n, 0, start)).toThrow(EpochNotAnchored);
  });

  it("keeps a settled epoch priceable after its hash ages out", async () => {
    const clock = fakeClock();
    const start = 240_000n * RATE_EPOCH_BLOCKS;
    const adapter = new MockAdapter({now: clock.now, startBlock: start});

    await adapter.rebalance(EVEN, HASH);
    const settled = adapter.rateAtEpoch(240_000n, 0);

    // Well past the 256 block window the anchor came from. Without the stored
    // anchor this read would revert; with it the period stays verifiable forever.
    clock.advanceBlocks(10_000);
    expect(adapter.rateAtEpoch(240_000n, 0)).toBe(settled);
  });

  it("reverts for a past epoch nobody ever rebalanced in", () => {
    const start = 240_000n * RATE_EPOCH_BLOCKS;
    const adapter = new MockAdapter({startBlock: start});

    // Long settled, never anchored, hash long gone. No rate was ever applied then,
    // so there is nothing to verify and nothing to invent.
    expect(() => adapter.rateAtEpoch(1n, 0, start)).toThrow(EpochNotAnchored);
  });

  it("never redraws an epoch's anchor once stored", async () => {
    const clock = fakeClock();
    const start = 240_000n * RATE_EPOCH_BLOCKS;
    const adapter = new MockAdapter({now: clock.now, startBlock: start});

    await adapter.rebalance(EVEN, HASH);
    const first = adapter.epochAnchor(240_000n);

    clock.advanceSeconds(REBALANCE_COOLDOWN_SECONDS);
    await adapter.rebalance(EVEN, HASH);
    expect(adapter.epochAnchor(240_000n)).toBe(first);
  });

  it("keeps the epoch inside the blockhash window", () => {
    // Load-bearing, not decorative: an epoch longer than the window would stop
    // resolving partway through itself. Asserted on the Foundry side too.
    expect(RATE_EPOCH_BLOCKS).toBeLessThan(BLOCKHASH_WINDOW_BLOCKS);
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
    // Epoch 81 pays 129/160/121 bps, so the book should rise.
    const adapter = new MockAdapter({
      now: clock.now,
      startBlock: 81n * RATE_EPOCH_BLOCKS,
      principal: parseEther("100"),
    });

    // Recomputed here rather than read back, so the test does not simply agree
    // with the implementation it is checking.
    const rates = [0, 1, 2].map((i) => adapter.rateAtEpoch(81n, i));
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
   * Epoch 5 pays -104/-131/-135 bps, so every strategy loses and the outcome does
   * not depend on how the book is allocated. Ticking at the cooldown advances about
   * seven blocks a time, so the run stays inside the epoch.
   *
   * Found by search rather than by lookup, and it has to be: the anchor for an
   * epoch cannot be known until the chain reaches it, so picking an adverse period
   * means rolling into each candidate and reading it, not computing it ahead. The
   * test suite cannot see the future either — that is the property working.
   */
  const ADVERSE_EPOCH = 5n;
  const ADVERSE_START_BLOCK = ADVERSE_EPOCH * RATE_EPOCH_BLOCKS;

  function adverseAdapter() {
    const clock = fakeClock();
    const adapter = new MockAdapter({
      now: clock.now,
      startBlock: ADVERSE_START_BLOCK,
      principal: parseEther("100"),
    });
    return {clock, adapter};
  }

  it("starts in an epoch where every strategy loses", () => {
    // Pins the premise the three tests below rest on. If the derivation moves
    // again this fails first, and points straight at the cause.
    const {adapter} = adverseAdapter();
    const anchor = adapter.epochAnchor(ADVERSE_EPOCH);
    for (let id = 0; id < 3; id++) {
      expect(adapter.rateFromAnchor(anchor, id)).toBeLessThanOrEqual(-100n);
    }
  });

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
    expect(adapter.currentEpoch()).toBe(ADVERSE_EPOCH);
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
