import { murmur3String } from "../hash/murmur3";

/** Complete, JSON-serializable PRNG state. */
export interface RngState {
  seedKey: string;
  a: number;
  b: number;
  c: number;
  d: number;
}

const WARMUP_ROUNDS = 12;
const TWO_POW_32 = 4294967296;

/**
 * Seeded sfc32 generator.
 *
 * Named sub-streams come from `split(name)`. A sub-stream is derived from the parent's seed key,
 * not its current position, so drawing from one stream never shifts another.
 */
export class Rng {
  private constructor(
    private readonly seedKey: string,
    private a: number,
    private b: number,
    private c: number,
    private d: number,
  ) {}

  static fromSeed(seedKey: string): Rng {
    const rng = new Rng(
      seedKey,
      murmur3String(seedKey, 0x01) | 0,
      murmur3String(seedKey, 0x02) | 0,
      murmur3String(seedKey, 0x03) | 0,
      murmur3String(seedKey, 0x04) | 0,
    );
    for (let i = 0; i < WARMUP_ROUNDS; i++) rng.next();
    return rng;
  }

  static fromState(state: RngState): Rng {
    return new Rng(state.seedKey, state.a | 0, state.b | 0, state.c | 0, state.d | 0);
  }

  getState(): RngState {
    return { seedKey: this.seedKey, a: this.a, b: this.b, c: this.c, d: this.d };
  }

  clone(): Rng {
    return Rng.fromState(this.getState());
  }

  /** Independent named sub-stream; deterministic in (seedKey, name) alone. */
  split(name: string): Rng {
    return Rng.fromSeed(`${this.seedKey}/${name}`);
  }

  /** Next unsigned 32-bit integer. */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / TWO_POW_32;
  }

  /** Unbiased integer in [0, n), for 1 <= n <= 2^32. */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
      throw new RangeError(`Rng.int needs an integer in [1, 2^32], got ${n}`);
    }
    if (n === TWO_POW_32) return this.next();
    const limit = TWO_POW_32 - (TWO_POW_32 % n);
    let x = this.next();
    while (x >= limit) x = this.next();
    return x % n;
  }
}
