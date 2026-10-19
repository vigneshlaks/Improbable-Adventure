import math

from .hash import DEFAULT_SEED, hash32

#: The least a level can hold.
_MIN_LEVEL = 2
#: Mixed into the seed to get the coin a compaction flips.
_COIN_SALT = 0x6A09E667


class KllSketch:
    """KLL Sketch (Karnin, Lang and Liberty): estimates quantiles (the median, the 99th percentile, the rank of a value) of a stream of numbers in a few kilobytes.

    Items are kept in levels; an item at level l stands for 2^l items. When a level is over its capacity it is sorted and every second item (from a coin) is
    promoted to the level above and the rest dropped, so the ranks of the survivors stay right on average. The rank error is the same at every quantile and
    shrinks with k: about 1.6 / k of the items (the 95th percentile of the error, found by simulation). The sketch holds about 3k numbers however long the
    stream. Items cannot be removed. Two sketches of the same k and seed merge. The coin is a hash of a counter, not a random generator, so the same stream
    always makes the same sketch. Size it with `size_kll` in sizing.py.
    """

    def __init__(self, k: int, seed: int = DEFAULT_SEED) -> None:
        if not (k >= 2):
            raise ValueError("A KLL Sketch needs k of at least 2")
        self.k = int(k)
        self.seed = seed
        self._levels = [[]]
        self._compactions = 0
        self._added = 0

    @property
    def count(self) -> int:
        """Items added."""
        return self._added

    @property
    def items(self):
        """The items now stored, each with the number of items it stands for, in ascending order of value."""
        return sorted(((value, 2**level) for level, values in enumerate(self._levels) for value in values), key=lambda pair: pair[0])

    def _capacity_of(self, level: int) -> int:
        # k x (2/3)^depth rounded up, worked out in whole numbers: a power of 2/3 is not exact, and a result a hair under a whole number would round the other way on another machine.
        depth = len(self._levels) - 1 - level
        return max(_MIN_LEVEL, -(-self.k * 2**depth // 3**depth))

    def _compact(self) -> None:
        while True:
            for l in range(len(self._levels)):
                level = self._levels[l]
                if len(level) < self._capacity_of(l):
                    continue
                if l == len(self._levels) - 1:
                    self._levels.append([])
                level.sort()
                offset = hash32(self._compactions, (self.seed ^ _COIN_SALT) & 0xFFFFFFFF) & 1
                self._compactions += 1
                above = self._levels[l + 1]
                for i in range(offset, len(level) - (len(level) % 2), 2):
                    above.append(level[i])
                self._levels[l] = [level[-1]] if len(level) % 2 == 1 else []
                break  # the level above may now be over capacity: look again from the bottom
            else:
                return

    def add(self, value: float) -> None:
        if not math.isfinite(value):
            raise ValueError("A KLL Sketch takes finite numbers")
        self._added += 1
        self._levels[0].append(value)
        self._compact()

    def quantile(self, quantile: float):
        """The value at a quantile between 0 and 1 (0.5 is the median), or None when nothing was added."""
        items = self.items
        if not items:
            return None
        total = sum(weight for _, weight in items)
        needed = max(1, math.ceil(quantile * total - 1e-9))
        seen = 0
        for value, weight in items:
            seen += weight
            if seen >= needed:
                return value
        return items[-1][0]

    def rank(self, value: float) -> float:
        """The share of the items at or below a value."""
        items = self.items
        total = sum(weight for _, weight in items)
        if total == 0:
            return 0.0
        return sum(weight for v, weight in items if v <= value) / total

    @property
    def rank_error(self) -> float:
        """The rank error to expect, as a share of the items: 1.6 / k."""
        return 1.6 / self.k

    def merge(self, other: "KllSketch") -> "KllSketch":
        """The sketch of both streams: the items of each level together, then compacted. Needs the same k and seed."""
        if other.k != self.k or other.seed != self.seed:
            raise ValueError("KLL sketches merge only with the same k and seed")
        merged = KllSketch(self.k, self.seed)
        merged._levels = [list(level) for level in self._levels]
        for l, level in enumerate(other._levels):
            while len(merged._levels) <= l:
                merged._levels.append([])
            merged._levels[l].extend(level)
        merged._added = self._added + other._added
        merged._compactions = max(self._compactions, other._compactions)
        merged._compact()
        return merged
