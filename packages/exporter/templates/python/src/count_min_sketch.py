import math

from .hash import DEFAULT_SEED, Item, hash32

_COUNTER_MAX = 0xFFFFFFFF


class CountMinSketch:
    """Count-Min Sketch: estimates how many times each item was added, in a fixed grid of counters.

    It never underestimates; it overshoots by at most about (e / width) x total, with probability 1 - e^-depth.
    Items can be removed, but only items that were added. Size it with `size_count_min` in sizing.py.
    """

    def __init__(self, width: int, depth: int, seed: int = DEFAULT_SEED) -> None:
        if not (width >= 1) or not (depth >= 1):
            raise ValueError("A Count-Min Sketch needs at least one column and one row")
        self.width = int(width)
        self.depth = int(depth)
        self.seed = seed
        self._counters = [0] * (self.width * self.depth)
        self._row_seeds = [hash32(row, seed) for row in range(self.depth)]  # each row hashes independently
        self._total = 0

    def _slot(self, row: int, item: Item) -> int:
        return row * self.width + hash32(item, self._row_seeds[row]) % self.width

    def add(self, item: Item, count: int = 1) -> None:
        for row in range(self.depth):
            slot = self._slot(row, item)
            self._counters[slot] = min(_COUNTER_MAX, self._counters[slot] + count)
        self._total += count

    def remove(self, item: Item, count: int = 1) -> None:
        """Takes back `count` earlier additions of the item. Removing something never added makes other estimates wrong."""
        for row in range(self.depth):
            slot = self._slot(row, item)
            self._counters[slot] = max(0, self._counters[slot] - count)
        self._total = max(0, self._total - count)

    def estimate(self, item: Item) -> int:
        """At least the true count, and usually close to it."""
        return min(self._counters[self._slot(row, item)] for row in range(self.depth))

    @property
    def overshoot(self) -> float:
        """How far an estimate is likely to overshoot: (e / width) x total."""
        return math.e / self.width * self._total
