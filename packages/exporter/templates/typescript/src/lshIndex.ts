import { DEFAULT_SEED, type Item } from "./hash.ts";
import { MinHash } from "./minHash.ts";

/** The chance that some band of `rows` rows agrees for two sets of similarity s, with `bands` bands: 1 - (1 - s^rows)^bands. */
export function candidateChance(similarity: number, rows: number, bands: number): number {
  return 1 - (1 - similarity ** rows) ** bands;
}

/**
 * The most rows a band can have while two sets exactly at the similarity `threshold` still become candidates with chance `recall`, for k minima cut into
 * bands of that many (k / rows of them). More rows make a band pickier, so fewer look-alikes become candidates, but a similar pair must not be missed.
 */
export function bandRowsFor(k: number, threshold: number, recall: number): number {
  let best = 1;
  for (let rows = 1; rows <= k; rows++) {
    if (candidateChance(threshold, rows, Math.floor(k / rows)) >= recall) best = rows;
    else break;
  }
  return best;
}

/**
 * Locality-Sensitive Hashing index (Indyk and Motwani; the banding of Leskovec and others): finds, among many stored sets, the ones that are probably
 * alike a query set, without comparing them all. Each stored set is cut to a MinHash signature of k minima, and the signature into bands of `rows` rows;
 * two sets are candidates if, in some band, every row agrees. A pair of similarity s does that with chance 1 - (1 - s^rows)^bands. The rows are the most for
 * which a pair exactly at the `threshold` is still found with chance `recall`, so a pair above the threshold is almost never missed, at the price of some
 * pairs below it being found too: check the candidates with `MinHash.similarity`. Size it with `sizeLsh` in sizing.ts.
 */
export class LshIndex {
  readonly k: number;
  readonly seed: number;
  readonly rows: number;
  readonly bands: number;
  private readonly buckets: Array<Map<string, Set<string | number>>> = [];
  private readonly signatures = new Map<string | number, MinHash>();

  constructor(k: number, threshold = 0.6, recall = 0.9, seed = DEFAULT_SEED) {
    if (!(k >= 1)) throw new RangeError("An LSH index needs at least one minimum");
    if (!(threshold > 0 && threshold < 1) || !(recall > 0 && recall < 1)) throw new RangeError("The threshold and the recall must be between 0 and 1");
    this.k = Math.floor(k);
    this.seed = seed;
    this.rows = bandRowsFor(this.k, threshold, recall);
    this.bands = Math.floor(this.k / this.rows);
    for (let band = 0; band < this.bands; band++) this.buckets.push(new Map());
  }

  private signatureOf(items: readonly Item[]): MinHash {
    const hash = new MinHash(this.k, this.seed);
    for (const item of items) hash.add(item);
    return hash;
  }

  /** The key of each band of a signature, or null for a band that saw nothing. */
  private keysOf(signature: readonly number[]): Array<string | null> {
    return Array.from({ length: this.bands }, (_, band) => {
      const rows = signature.slice(band * this.rows, (band + 1) * this.rows);
      return rows.every((m) => m === 2 ** 32) ? null : rows.join(",");
    });
  }

  /** Stores a set under an id (a number or a string). Adding an id again replaces nothing: use a new id. */
  add(id: string | number, items: readonly Item[]): void {
    if (this.signatures.has(id)) throw new Error(`The id ${String(id)} is already stored`);
    const signature = this.signatureOf(items);
    this.signatures.set(id, signature);
    this.keysOf(signature.signature).forEach((key, band) => {
      if (key === null) return;
      const bucket = (this.buckets[band] as Map<string, Set<string | number>>).get(key) ?? new Set();
      bucket.add(id);
      (this.buckets[band] as Map<string, Set<string | number>>).set(key, bucket);
    });
  }

  /** The ids of the stored sets that are candidates for being alike the query set. */
  query(items: readonly Item[]): Array<string | number> {
    const found = new Set<string | number>();
    this.keysOf(this.signatureOf(items).signature).forEach((key, band) => {
      if (key === null) return;
      for (const id of (this.buckets[band] as Map<string, Set<string | number>>).get(key) ?? []) found.add(id);
    });
    return [...found];
  }

  /** A stored set's MinHash, to check a candidate with `similarity`. */
  signature(id: string | number): MinHash | undefined {
    return this.signatures.get(id);
  }
}
