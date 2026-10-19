import math

from .hash import DEFAULT_SEED, Item, hash32

#: Mixed into a row's seed to get the hash that picks the sign of an item in that row.
_SIGN_SALT = 0x9E3779B9


def _wrap32(x: int) -> int:
    """A Python integer as a signed 32-bit one, as the counters of the other languages wrap."""
    return ((x + 0x80000000) & 0xFFFFFFFF) - 0x80000000


def _median(values):
    ordered = sorted(values)
    middle = len(ordered) >> 1
    return ordered[middle] if len(ordered) % 2 == 1 else (ordered[middle - 1] + ordered[middle]) / 2


class CountSketch:
    """Count Sketch: estimates how many times each item was added, in a grid of signed counters.

    An item goes to one counter in every row with a sign of +1 or -1 of its own there, so other items' collisions add and subtract and
    cancel on average: the estimate is unbiased, and can be below the truth as well as above it. The estimate is the median over the rows.
    Its error follows the stream's L2 norm (the square root of the sum of squared counts), so it beats a Count-Min Sketch when a few items
    are heavy. Items can be removed. Size it with `size_count_sketch` in sizing.py.
    """

    def __init__(self, width: int, depth: int, seed: int = DEFAULT_SEED) -> None:
        if not (width >= 1) or not (depth >= 1):
            raise ValueError("A Count Sketch needs at least one column and one row")
        self.width = int(width)
        self.depth = int(depth)
        self.seed = seed
        self._counters = [0] * (self.width * self.depth)
        self._row_seeds = [hash32(row, seed) for row in range(self.depth)]  # each row hashes independently

    def _slot(self, row: int, item: Item) -> int:
        return row * self.width + hash32(item, self._row_seeds[row]) % self.width

    def _sign(self, row: int, item: Item) -> int:
        return 1 if hash32(item, (self._row_seeds[row] ^ _SIGN_SALT) & 0xFFFFFFFF) & 1 == 0 else -1

    def add(self, item: Item, count: int = 1) -> None:
        for row in range(self.depth):
            slot = self._slot(row, item)
            self._counters[slot] = _wrap32(self._counters[slot] + count * self._sign(row, item))

    def remove(self, item: Item, count: int = 1) -> None:
        """Takes back `count` earlier additions. Exact: a removed item leaves no trace."""
        self.add(item, -count)

    def raw_estimate(self, item: Item) -> float:
        """The median over the rows of sign x counter: may be fractional (an even depth averages the middle two) or below zero."""
        return _median([self._sign(row, item) * self._counters[self._slot(row, item)] for row in range(self.depth)])

    def estimate(self, item: Item) -> float:
        """The estimate of the count, never below zero."""
        return max(0, self.raw_estimate(item))

    @property
    def squared_norm(self) -> float:
        """The squared L2 norm of the counts added, estimated as the median over the rows of the sum of squared counters."""
        return _median([sum(c * c for c in self._counters[row * self.width : (row + 1) * self.width]) for row in range(self.depth)])

    @property
    def error_band(self) -> float:
        """How far an estimate is off, either way, in the worst case the sizing plans for: `2 sqrt(squared norm / width)`,
        which is `error x L2 norm` for a sketch sized by `size_count_sketch`."""
        return 2 * math.sqrt(self.squared_norm / self.width)
