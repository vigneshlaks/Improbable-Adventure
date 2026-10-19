from .hash import DEFAULT_SEED, Item
from .k_minimum_values import KMinimumValues

_HASH_RANGE = 2**32


class ThetaSketch:
    """Theta Sketch (Dasgupta and others; Apache DataSketches): K-Minimum Values built for set arithmetic.

    It keeps the k smallest hashes of the different items added; the largest of them, as a share of the hash range, is theta, and every item whose hash is
    below theta is in the sketch, so the sketch is a sample of the items at rate theta. That sample gives the count (the number of hashes over theta), and two
    sketches give the count of the union (take the k smallest hashes of both) and of the intersection (the hashes both hold below the smaller theta, over that
    theta), with an error of about 1 / sqrt(k - 2) of the union. Adding an item again changes nothing, and nothing can be removed. Size it with `size_kmv` in
    sizing.py (it is the same size).
    """

    def __init__(self, k: int, seed: int = DEFAULT_SEED) -> None:
        self.k = k
        self.seed = seed
        self._inner = KMinimumValues(k, seed)

    @property
    def hashes(self):
        """The kept hashes, smallest first."""
        return self._inner.hashes

    @property
    def theta(self) -> float:
        """The share of the hash range below which every item is in the sketch (1 while it holds every different item it has seen)."""
        hashes = self._inner.hashes
        return 1.0 if len(hashes) < self.k else hashes[self.k - 1] / _HASH_RANGE

    def add(self, item: Item) -> None:
        self._inner.add(item)

    def count(self) -> float:
        """The estimated number of different items."""
        return self._inner.count()

    @property
    def standard_error(self) -> float:
        """The relative standard error of `count`."""
        return self._inner.standard_error

    def union(self, other: "ThetaSketch") -> "ThetaSketch":
        """The sketch of both streams. Needs the same k and seed."""
        if other.k != self.k or other.seed != self.seed:
            raise ValueError("Theta sketches combine only with the same k and seed")
        merged = ThetaSketch(self.k, self.seed)
        merged._inner = self._inner.merge(other._inner)
        return merged

    def intersection_count(self, other: "ThetaSketch") -> float:
        """The estimated number of items in both streams: the hashes both sketches hold below the smaller theta, over that theta."""
        if other.k != self.k or other.seed != self.seed:
            raise ValueError("Theta sketches combine only with the same k and seed")
        theta = min(self.theta, other.theta)
        mine = set(self._inner.hashes)
        shared = sum(1 for h in other._inner.hashes if h in mine and h / _HASH_RANGE < theta)
        return shared if theta == 1 else shared / theta
