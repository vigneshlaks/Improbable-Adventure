import { Rng } from "../rng/rng";
import { binomialUpper, clamp, clopperPearson } from "../stats/stats";
import { expectedGhostShare } from "./ghosts";
import { expectKind, optionsFromSnapshot, readCounts, readNumber, readRngState, snapshotHeader } from "./snapshot";
import {
  assertSpace,
  type Answer,
  type Challenge,
  type Structure,
  type StructureConstants,
  type StructureOptions,
  type StreamEvent,
  type StructureSnapshot,
} from "./types";

/**
 * Reservoir sampling: a uniform random sample of the insert stream, one slot per VALUE_BITS of Space.
 * Counts are estimated by scaling up from the sample. It cannot see deletes, so deleted values stay in
 * the sample as ghosts. It counts the delete events it ignores, and widens the low bound of its ranges by
 * that many, because the sample describes what was ever inserted and the truth is what is still live.
 * Its raw values are shown to the player.
 *
 * The number of deletes against the number of inserts gives the share of units deleted, q. Treating each unit as
 * deleted independently with chance q, a Frequency answer is the ever-inserted count thinned by q, and a Count
 * answer loses at most the ghosts a binomial in q allows. A Presence answer cannot be bounded this way, because
 * which targets are ghosts depends on how the challenge chose them, so it keeps the worst-case widening.
 */
export class ReservoirSampling implements Structure {
  readonly kind = "reservoirSampling" as const;
  readonly params: Readonly<Record<string, number>>;

  private sample: number[] = [];
  private seen = 0;
  private deleteCount = 0;
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

  /** Delete events seen and ignored. Each ghost needs at least one, so there are never more ghosts than this. */
  get deletes(): number {
    return this.deleteCount;
  }

  /** The share of inserted units that have since been deleted. The structure can count both, so this is known. */
  private get deletedShare(): number {
    return this.seen === 0 ? 1 : Math.min(1, this.deleteCount / this.seen);
  }

  ingest(event: StreamEvent): void {
    if (event.op === "delete") {
      this.deleteCount++; // a sample cannot tell which value left, but it can count the departures
      return;
    }
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
        // A sampled value was inserted at some point, possibly deleted since, and at most as many sampled
        // values are ghosts as there were deletes. Unsampled targets may still be present.
        return {
          estimate: flagged,
          low: flagged.length - Math.min(this.deleteCount, flagged.length),
          high: challenge.targets.length,
          confidence,
        };
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
    const exact = this.seen <= this.slots;

    if (this.deleteCount === 0) {
      if (exact) return { estimate: c, low: c, high: c, confidence };
      const N = this.seen;
      // Exact range on the sample's share, scaled to the stream. The usual normal approximation
      // breaks down when almost none or almost all of the sample matches.
      const { low, high } = clopperPearson(c, n, confidence);
      return { estimate: (c * N) / n, low: Math.max(c, N * low), high: Math.min(N, N * high), confidence };
    }

    // The error budget is shared by the sources of error. Each side of the range may miss with chance `tail`
    // from each source: the sampling (when there is any) and the deletions.
    const tail = (1 - confidence) / (exact ? 2 : 4);
    let ever = { estimate: c, low: c, high: c };
    if (!exact) {
      const N = this.seen;
      const { low, high } = clopperPearson(c, n, 1 - 2 * tail);
      ever = { estimate: (c * N) / n, low: Math.max(c, N * low), high: Math.min(N, N * high) };
    }
    return this.thinned(ever, tail, confidence);
  }

  /** Turns a range for the ever-inserted count into one for the live count, by thinning it with the deleted share. */
  private thinned(ever: { estimate: number; low: number; high: number }, tail: number, confidence: number): Answer {
    const q = this.deletedShare;
    // Fewest survivors: the most deletions plausible among the fewest units. Most survivors: the reverse.
    const low = Math.max(0, ever.low - binomialUpper(Math.ceil(ever.low), q, 1 - tail));
    const high = Math.max(low, ever.high - binomialUpper(Math.floor(ever.high), q, tail));
    return { estimate: clamp(ever.estimate * (1 - q), low, high), low, high, confidence };
  }

  private distinct(confidence: number): Answer {
    const n = this.sample.length;
    const freq = new Map<number, number>();
    for (const v of this.sample) freq.set(v, (freq.get(v) ?? 0) + 1);
    const dSample = freq.size;
    let ever = { estimate: dSample, low: dSample, high: dSample };
    if (this.seen > this.slots) {
      let singletons = 0;
      for (const f of freq.values()) if (f === 1) singletons++;
      const ratio = Math.sqrt(this.seen / n);
      const estimate = ratio * singletons + (dSample - singletons);
      ever = { estimate, low: clamp(estimate / ratio, dSample, this.seen), high: clamp(estimate * ratio, dSample, this.seen) };
    }
    if (this.deleteCount === 0) return { ...ever, confidence };

    // Live values are the ever-inserted ones minus the ghosts. A value is a ghost with chance at most q (one with
    // several units is less likely to vanish), so the ghosts are at most a binomial in q. Live cannot exceed ever.
    const ghosts = binomialUpper(Math.ceil(ever.low), this.deletedShare, confidence);
    const low = Math.max(0, ever.low - ghosts);
    const expected = ever.estimate * (1 - expectedGhostShare(this.seen, this.deleteCount, ever.estimate));
    return { estimate: clamp(expected, low, ever.high), low, high: ever.high, confidence };
  }

  snapshot(): StructureSnapshot {
    return {
      ...snapshotHeader(this.kind, this.options),
      // The random generator's position is part of the state: a restored sample must keep making the
      // same random choices as the original.
      state: { sample: [...this.sample], seen: this.seen, deletes: this.deleteCount, rng: { ...this.rng.getState() } },
    };
  }

  static fromSnapshot(snapshot: StructureSnapshot, constants: StructureConstants): ReservoirSampling {
    expectKind(snapshot, "reservoirSampling");
    const sampler = new ReservoirSampling(optionsFromSnapshot(snapshot), constants);
    const sample = readCounts(snapshot.state, "sample");
    if (sample.length > sampler.slots) throw new RangeError('Bad snapshot: "sample" exceeds its slots');
    sampler.sample = sample;
    sampler.seen = readNumber(snapshot.state, "seen");
    sampler.deleteCount = readNumber(snapshot.state, "deletes");
    sampler.rng = Rng.fromState(readRngState(snapshot.state));
    return sampler;
  }

  clone(): ReservoirSampling {
    const copy = new ReservoirSampling(this.options, this.constants);
    copy.sample = [...this.sample];
    copy.seen = this.seen;
    copy.deleteCount = this.deleteCount;
    copy.rng = this.rng.clone();
    return copy;
  }
}
