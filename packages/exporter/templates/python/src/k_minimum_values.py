import bisect
import math

from .hash import DEFAULT_SEED, Item, hash32

_HASH_RANGE = 2**32


class KMinimumValues:
    """K-Minimum Values: counts different items by keeping only the k smallest hashes of the items seen.

    While it has seen fewer than k different items it counts them exactly. Past that, the k-th smallest hash, as a share u of the hash range,
    says how crowded the items are: with n different items the k smallest hashes fill about k / n of the range, so the estimate is (k - 1) / u,
    with a relative standard error of about 1 / sqrt(k - 2). Adding an item again changes nothing, nothing can be removed, and two sketches
    of the same size and seed merge into the sketch of both streams. Size it with `size_kmv` in sizing.py.
    """

    def __init__(self, k: int, seed: int = DEFAULT_SEED) -> None:
        if not (k >= 3):
            raise ValueError("K-Minimum Values needs k of at least 3")
        self.k = int(k)
        self.seed = seed
        self._sorted = []

    @property
    def hashes(self):
        """The kept hashes, smallest first."""
        return tuple(self._sorted)

    def add(self, item: Item) -> None:
        value = hash32(item, self.seed)
        position = bisect.bisect_left(self._sorted, value)
        if position < len(self._sorted) and self._sorted[position] == value:
            return  # an item already kept
        if len(self._sorted) < self.k:
            self._sorted.insert(position, value)
        elif position < self.k:
            self._sorted.insert(position, value)
            self._sorted.pop()

    def count(self) -> float:
        """The estimated number of different items."""
        if len(self._sorted) < self.k:
            return len(self._sorted)
        return (self.k - 1) / (self._sorted[self.k - 1] / _HASH_RANGE)

    @property
    def standard_error(self) -> float:
        """The relative standard error of `count`: 0 while it holds every different item, otherwise 1 / sqrt(k - 2)."""
        return 0.0 if len(self._sorted) < self.k else 1 / math.sqrt(self.k - 2)

    def merge(self, other: "KMinimumValues") -> "KMinimumValues":
        """The sketch of both streams: the k smallest hashes of both. Needs the same k and seed."""
        if other.k != self.k or other.seed != self.seed:
            raise ValueError("Sketches merge only with the same k and seed")
        merged = KMinimumValues(self.k, self.seed)
        merged._sorted = sorted(set(self._sorted) | set(other._sorted))[: self.k]
        return merged
