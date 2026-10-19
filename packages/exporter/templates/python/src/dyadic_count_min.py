import math

from .count_min_sketch import CountMinSketch
from .hash import DEFAULT_SEED

_SEED_SALT = 0x9E3779B1


class DyadicCountMin:
    """Dyadic Count-Min (Cormode and Muthukrishnan): quantiles and ranks from Count-Min Sketches.

    A value is cut to its top `bits` bits, giving 2^bits ordered buckets (the value range split into equal parts, each 2^(32 - bits) values wide). Level j
    counts every aligned run of 2^j buckets (the dyadic intervals: the whole range, its halves, quarters, ...), so the number of items at or below any
    value is a sum of at most `bits + 1` of those counts, and a quantile is found by walking down from the whole range, going left when the target falls in
    the left half. A level with few intervals (at most `exact_max`) is kept in exact counters; the others are Count-Min Sketches of `width` columns and
    `depth` rows, which only overcount, so the rank of a value is never too low and is too high by at most the sum of the sketches' bands, `rank_overshoot`.
    Values are whole numbers from 0 to 2^32 - 1. Items can be removed. Size it with `size_dyadic` in sizing.py.
    """

    def __init__(self, bits: int, width: int, depth: int, seed: int = DEFAULT_SEED, exact_max: int = 64) -> None:
        if not isinstance(bits, int) or bits < 2 or bits > 32:
            raise ValueError("A Dyadic Count-Min takes 2 to 32 bits of the value")
        self.bits = bits
        self.width = int(width)
        self.depth = int(depth)
        self.seed = seed
        self.exact_max = exact_max
        self._exact = []
        self._sketches = []
        for j in range(bits):
            if 2 ** (bits - j) <= exact_max:
                self._exact.append([0] * 2 ** (bits - j))
                self._sketches.append(None)
            else:
                self._exact.append(None)
                self._sketches.append(CountMinSketch(width, depth, (seed + ((j + 1) * _SEED_SALT & 0xFFFFFFFF)) & 0xFFFFFFFF))
        self._total = 0

    @property
    def live_total(self) -> int:
        """Items added minus items removed."""
        return self._total

    @property
    def bucket_width(self) -> int:
        """The width of one bucket, in values."""
        return 2 ** (32 - self.bits)

    def _bucket(self, value: int) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 0xFFFFFFFF:
            raise ValueError("A value is a whole number from 0 to 2^32 - 1")
        return value >> (32 - self.bits)

    def add(self, value: int) -> None:
        bucket = self._bucket(value)
        for j in range(self.bits):
            level = self._exact[j]
            if level is not None:
                level[bucket >> j] += 1
            else:
                self._sketches[j].add(bucket >> j)
        self._total += 1

    def remove(self, value: int) -> None:
        """Takes back an earlier addition. Only remove values that were added."""
        if self._total == 0:
            return
        bucket = self._bucket(value)
        for j in range(self.bits):
            level = self._exact[j]
            if level is not None:
                level[bucket >> j] = max(0, level[bucket >> j] - 1)
            else:
                self._sketches[j].remove(bucket >> j)
        self._total -= 1

    def _count(self, level: int, key: int) -> int:
        """The count of the aligned run of 2^level buckets with this key: exact above, an overestimate in a sketch."""
        if level == self.bits:
            return self._total
        exact = self._exact[level]
        return exact[key] if exact is not None else self._sketches[level].estimate(key)

    @property
    def rank_overshoot(self) -> float:
        """The sum of what the sketches may overshoot by, expected: the band `e N / width` of each."""
        return sum(sketch.overshoot for sketch in self._sketches if sketch is not None)

    def rank(self, value: int) -> int:
        """The number of items at or below the bucket of a value (the whole bucket counts), never too low and too high by at most `rank_overshoot`."""
        remaining = self._bucket(value) + 1  # the buckets 0 .. bucket, as the largest runs of 2^j buckets that fit, one after another
        position = 0
        total = 0
        for j in range(self.bits, -1, -1):
            run = 2**j
            if remaining >= run:
                total += self._count(j, position // run)
                position += run
                remaining -= run
        return min(self._total, total)

    def _bucket_at(self, target: float) -> int:
        """The bucket that holds the unit at `target` (counting from 1) when the units are in order, as far as the counts say."""
        key = 0
        remaining = max(1, math.ceil(target))
        for level in range(self.bits, 0, -1):
            left = min(self._count(level - 1, key * 2), self._count(level, key))
            if remaining <= left:
                key = key * 2
            else:
                remaining -= left
                key = key * 2 + 1
        return key

    def quantile(self, quantile: float):
        """The value at a quantile between 0 and 1: the upper edge of the bucket found, with its lower edge, and an upper end for where the quantile can be (the
        upper edge of the bucket found for the target plus the overshoot), which is infinity when that reaches past the total. None when nothing is held."""
        if self._total <= 0:
            return None
        target = quantile * self._total
        found = self._bucket_at(target)
        bound = target + self.rank_overshoot
        above = self._bucket_at(bound) if bound <= self._total else None
        return {
            "estimate": (found + 1) * self.bucket_width - 1,
            "low": found * self.bucket_width,
            "high": math.inf if above is None else (above + 1) * self.bucket_width - 1,
        }
