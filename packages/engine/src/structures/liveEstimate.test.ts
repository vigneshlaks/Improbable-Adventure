import { describe, expect, it } from "vitest";
import { LiveSet } from "../enemies/liveSet";
import { createStream, nextBurst, type StreamParams } from "../enemies/stream";
import { LinearCounting } from "./linearCounting";
import { LogLog } from "./logLog";
import { ReservoirSampling } from "./reservoirSampling";
import type { Structure } from "./types";
import { TEST_CONSTANTS } from "./testUtils";

// The Count estimate should aim at the values live now, not at the values ever inserted. These tests run the game's
// own enemy streams: five turns of 200 events growing 35 percent a turn, with drifting favorites.

const TRIALS_PER_MIX = 60;

interface Mix {
  universe: number;
  skew: number;
  churn: number;
}

function runMix(mix: Mix, make: () => Structure, label: string): { corrected: number; ever: number } {
  const params: StreamParams = { ...mix, growth: 1.35, drift: { fraction: 0.25, everyTurns: 4 }, baseBurst: 200 };
  let corrected = 0;
  let ever = 0;
  for (let t = 0; t < TRIALS_PER_MIX; t++) {
    let stream = createStream(`${label}-${mix.universe}-${mix.skew}-${mix.churn}-${t}`);
    const live = new LiveSet();
    const structure = make();
    for (let turn = 0; turn < 5; turn++) {
      const burst = nextBurst(params, stream, live);
      stream = burst.state;
      for (const event of burst.events) structure.ingest(event);
    }
    const everInserted = live.distinct + live.ghosts().length;
    const estimate = structure.query({ kind: "count" })?.estimate as number;
    corrected += Math.abs(estimate - live.distinct) / live.distinct;
    ever += Math.abs(everInserted - live.distinct) / live.distinct;
  }
  return { corrected: corrected / TRIALS_PER_MIX, ever: ever / TRIALS_PER_MIX };
}

// Roomy structures (LogLog the opposite, so it is in its valid regime), so what is left is the effect of the deletes and not the structure's own error.
const linearCounting = () => new LinearCounting({ spaceBits: 65536 }, TEST_CONSTANTS);
const logLog = () => new LogLog({ spaceBits: 5 * 64 }, TEST_CONSTANTS); // 64 registers, far fewer than the values
const reservoir = () => new ReservoirSampling({ spaceBits: 32 * 4096 }, TEST_CONSTANTS); // the sample holds the whole stream

describe("the Count estimate aims at the live values", () => {
  it("is within a few percent of the live count where most values appear once, at every churn", () => {
    for (const [name, make] of [["Linear Counting", linearCounting], ["Reservoir Sampling", reservoir]] as const) {
      for (const universe of [16384, 4194304]) {
        for (const churn of [0.1, 0.3]) {
          const { corrected, ever } = runMix({ universe, skew: 0.8, churn }, make, name);
          expect(corrected, `${name}, ${universe} values, churn ${churn}`).toBeLessThan(0.08);
          expect(corrected, `${name}, ${universe} values, churn ${churn}`).toBeLessThan(ever / 2);
        }
      }
    }
  });

  it("is close to the live count when values repeat a lot, where few values vanish", () => {
    const { corrected, ever } = runMix({ universe: 256, skew: 0.8, churn: 0.3 }, linearCounting, "repeat");
    expect(corrected).toBeLessThan(0.2);
    expect(corrected).toBeLessThanOrEqual(ever);
  });

  it("still improves on the ever-inserted count when a few favorites dominate and most values appear once", () => {
    const { corrected, ever } = runMix({ universe: 16384, skew: 1.2, churn: 0.3 }, linearCounting, "heavy");
    expect(corrected).toBeLessThan(ever * 0.6);
  });

  it("changes nothing when there is no churn", () => {
    const { corrected, ever } = runMix({ universe: 16384, skew: 0.8, churn: 0 }, linearCounting, "calm");
    expect(corrected).toBeCloseTo(ever, 2);
    expect(corrected).toBeLessThan(0.02);
  });

  it("also holds for LogLog on a stream big enough for it", () => {
    const { corrected, ever } = runMix({ universe: 4194304, skew: 0.8, churn: 0.3 }, logLog, "loglog");
    expect(corrected).toBeLessThan(ever / 2);
  });
});
