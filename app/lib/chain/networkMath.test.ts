import {describe, expect, it} from "vitest";

import {addSample, blockTimeMsFrom, MAX_SAMPLES, meanTxPerBlock, tpsFrom} from "./networkMath";

describe("block time measurement", () => {
  it("converts a wide span into milliseconds per block", () => {
    // 600 seconds across 2000 blocks is 300ms, Monad's post-MIP-12 block time.
    expect(blockTimeMsFrom(1_000_600n, 1_000_000n, 2_000n)).toBeCloseTo(300);
  });

  it("stays accurate under second-granularity timestamps when the span is wide", () => {
    // The trap: timestamps round to whole seconds while blocks are sub-second, so a
    // ±1s error has to be amortised across a long span to stay negligible.
    const exact = blockTimeMsFrom(1_000_600n, 1_000_000n, 2_000n)!;
    const roundedUp = blockTimeMsFrom(1_000_601n, 1_000_000n, 2_000n)!;
    expect(Math.abs(roundedUp - exact) / exact).toBeLessThan(0.002);
  });

  it("returns null rather than zero when no time has elapsed", () => {
    // Zero would render as an infinitely fast chain. Absence is the honest answer.
    expect(blockTimeMsFrom(1_000_000n, 1_000_000n, 2_000n)).toBeNull();
  });

  it("returns null for a non-positive span", () => {
    expect(blockTimeMsFrom(1_000_600n, 1_000_000n, 0n)).toBeNull();
  });

  it("returns null if the older block is somehow newer", () => {
    expect(blockTimeMsFrom(1_000_000n, 1_000_600n, 2_000n)).toBeNull();
  });
});

describe("throughput", () => {
  it("averages the retained samples", () => {
    expect(meanTxPerBlock([1, 2, 3, 2])).toBeCloseTo(2);
  });

  it("is null with no samples, never zero", () => {
    expect(meanTxPerBlock([])).toBeNull();
  });

  it("derives tps from transactions per block and block time", () => {
    // 2 tx per block at 300ms per block is 6.67 tx/s.
    expect(tpsFrom(2, 300)).toBeCloseTo(6.667, 2);
  });

  it("is null when either input is unknown", () => {
    expect(tpsFrom(null, 300)).toBeNull();
    expect(tpsFrom(2, null)).toBeNull();
  });

  it("refuses to divide by a zero block time", () => {
    expect(tpsFrom(2, 0)).toBeNull();
  });
});

describe("sampling", () => {
  it("ignores a block it has already counted", () => {
    // The UI refreshes faster than a new block appears when the chain is quiet.
    // Counting the same block twice would silently weight it twice in the mean.
    const first = addSample([], {height: 10n, txCount: 5});
    const second = addSample(first, {height: 10n, txCount: 5});
    expect(second).toHaveLength(1);
  });

  it("appends genuinely new blocks", () => {
    const samples = addSample(addSample([], {height: 10n, txCount: 5}), {
      height: 11n,
      txCount: 3,
    });
    expect(samples).toHaveLength(2);
    expect(meanTxPerBlock(samples.map((s) => s.txCount))).toBeCloseTo(4);
  });

  it("keeps the window bounded during a long run", () => {
    let samples: {height: bigint; txCount: number}[] = [];
    for (let i = 0; i < MAX_SAMPLES * 3; i++) {
      samples = addSample(samples, {height: BigInt(i), txCount: 1});
    }
    expect(samples).toHaveLength(MAX_SAMPLES);
  });

  it("drops the oldest sample first", () => {
    let samples: {height: bigint; txCount: number}[] = [];
    for (let i = 0; i < MAX_SAMPLES + 1; i++) {
      samples = addSample(samples, {height: BigInt(i), txCount: i});
    }
    expect(samples[0].height).toBe(1n);
  });
});
