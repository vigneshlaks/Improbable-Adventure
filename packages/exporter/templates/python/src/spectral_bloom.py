import math

from .hash import DEFAULT_SEED, Item, positions


class SpectralBloom:
    """Spectral Bloom Filter: a Bloom Filter made of counters, so one structure answers "have I seen this?" and "how many times?", and items can be removed.

    An item adds one to each of its k counters; it may have been added if all of them are above zero, and its count is the smallest of them, which is
    never below the truth (the same guarantee as a Count-Min Sketch). All k counters share one array. A counter that reaches its top stops and is no longer
    reliable: it says "at least", and removals leave it alone. Size it with `size_spectral` in sizing.py.
    """

    def __init__(self, counters: int, hashes: int, seed: int = DEFAULT_SEED, counter_bits: int = 16) -> None:
        if not (counters >= 1) or not (hashes >= 1):
            raise ValueError("A Spectral Bloom Filter needs at least one counter and one hash")
        if not isinstance(counter_bits, int) or counter_bits < 2 or counter_bits > 32:
            raise ValueError("A counter takes 2 to 32 bits")
        self.counters = int(counters)
        self.hashes = int(hashes)
        self.seed = seed
        self.counter_bits = counter_bits
        self._max = 2**counter_bits - 1
        self._cells = [0] * self.counters
        self._total = 0

    @property
    def memory_bits(self) -> int:
        """The memory it takes."""
        return self.counters * self.counter_bits

    @property
    def live_total(self) -> int:
        """Items added minus items removed."""
        return self._total

    def add(self, item: Item, count: int = 1) -> None:
        for index in positions(item, self.hashes, self.counters, self.seed):
            self._cells[index] = min(self._max, self._cells[index] + count)
        self._total += count

    def remove(self, item: Item, count: int = 1) -> None:
        """Takes back `count` earlier additions. Exact for items that were added; a counter that has stopped is left alone."""
        for index in positions(item, self.hashes, self.counters, self.seed):
            c = self._cells[index]
            if 0 < c < self._max:
                self._cells[index] = max(0, c - count)
        self._total = max(0, self._total - count)

    def estimate(self, item: Item) -> int:
        """At least the true count, and usually close to it; a count at the counters' top means "at least this"."""
        return min(self._cells[index] for index in positions(item, self.hashes, self.counters, self.seed))

    def might_contain(self, item: Item) -> bool:
        """False means certainly not added (the smallest counter is zero). True means probably added."""
        return self.estimate(item) > 0

    @property
    def overshoot(self) -> float:
        """How far a count is likely to overshoot: the counters share one array, so an item's counter holds about k N / m units of others; the band is e times that."""
        return math.e * self.hashes * self._total / self.counters

    @property
    def false_positive_rate(self) -> float:
        """The false-positive rate right now, from the share of counters in use."""
        used = sum(1 for c in self._cells if c > 0)
        return (used / self.counters) ** self.hashes
