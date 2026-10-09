import { Rng } from "../rng/rng";
import { clamp, zForConfidence } from "../stats/stats";
import {
  assertSpace,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
} from "./types";

/**
 * Uniform sample of the insert stream (Algorithm R), one VALUE_BITS slot per sampled value.
 * It cannot see deletes, so deleted values linger in the sample as ghosts. Its raw values are shown to the player.
 *
 * Estimates scale by the sample fraction. Bounds:
 *  - frequency: normal approximation to the finite-population sample proportion;
 *  - distinct count: Charikar et al.'s GEE estimator, whose ratio error is at most sqrt(N / n).
 */
export class ReservoirSampling implements Structure {
  readonly kind = "reservoirSampling" as const;
  readonly params: Readonly<Record<string, number>>;

  private sample: number[] = [];
  private seen = 0;
  private rng: Rng;
  private readonly slots: number;

  constructor(
    private readonly options: StructureOptions,
    private readonly constants: StructureConstants,
  ) {
    assertSpace("reservoirSampling", options.spaceBits, constants.valueBits);
    this.slots = Math.floor(options.spaceBits / constants.valueBits);
    this.params = { slots: this.slots };
    this.rng = options.rng?.clone() ?? Rng.fromSeed("reservoir-default");
  }

  spaceBits(): number {
    return this.slots * this.constants.valueBits;
  }

  /** The raw sampled values, in slot order. */
  get values(): readonly number[] {
    return this.sample;
  }

  get insertsSeen(): number {
    return this.seen;
  }

  ingest(event: StreamEvent): void {
    if (event.op !== "insert") return; // deletes are invisible to a sample
    this.seen++;
    if (this.sample.length < this.slots) {
      this.sample.push(event.value);
      return;
    }
    const j = this.rng.int(this.seen);
    if (j < this.slots) this.sample[j] = event.value;
  }

  query(challenge: Challenge): Answer | null {
    const confidence = this.constants.confidence;
    switch (challenge.kind) {
      case "presence": {
        const inSample = new Set(this.sample);
        const flagged = challenge.targets.filter((t) => inSample.has(t));
        // Sample membership proves the value was inserted at some point (it may be a ghost).
        // Unsampled targets may still be present.
        return { estimate: flagged, low: flagged.length, high: challenge.targets.length, confidence };
      }
      case "frequency":
        return this.frequency(challenge.value, confidence);
      case "count":
        return this.distinct(confidence);
    }
  }

  private frequency(value: number, confidence: number): Answer {
    const n = this.sample.length;
    let c = 0;
    for (const v of this.sample) if (v === value) c++;
    if (this.seen <= this.slots) return { estimate: c, low: c, high: c, confidence };

    const N = this.seen;
    const scale = N / n;
    const estimate = c * scale;
    const p = c / n;
    const fpc = (N - n) / (N - 1);
    let se = Math.sqrt((p * (1 - p) * fpc) / n) * N;
    if (c === 0) {
      // Zero hits carries information but no variance estimate: use the exact "rule of three" style bound.
      const upper = N * (1 - Math.pow(1 - confidence, 1 / n));
      return { estimate, low: 0, high: upper, confidence };
    }
    if (c === n) se = 0;
    const z = zForConfidence(confidence);
    return { estimate, low: Math.max(c, estimate - z * se), high: Math.min(N, estimate + z * se), confidence };
  }

  private distinct(confidence: number): Answer {
    const n = this.sample.length;
    const freq = new Map<number, number>();
    for (const v of this.sample) freq.set(v, (freq.get(v) ?? 0) + 1);
    const dSample = freq.size;
    if (this.seen <= this.slots) return { estimate: dSample, low: dSample, high: dSample, confidence };

    let singletons = 0;
    for (const f of freq.values()) if (f === 1) singletons++;
    const ratio = Math.sqrt(this.seen / n);
    const estimate = ratio * singletons + (dSample - singletons);
    return {
      estimate,
      low: clamp(estimate / ratio, dSample, this.seen),
      high: clamp(estimate * ratio, dSample, this.seen),
      confidence,
    };
  }

  clone(): ReservoirSampling {
    const copy = new ReservoirSampling(this.options, this.constants);
    copy.sample = [...this.sample];
    copy.seen = this.seen;
    copy.rng = this.rng.clone();
    return copy;
  }
}
