import math

from .bloom_filter import BloomFilter
from .hash import DEFAULT_SEED, Item

#: Each new layer holds this many times as many items as the one before, and is this many times less likely to flag a stranger.
_GROWTH = 2
_TIGHTENING = 0.5
#: The layers' targets add up to this share of the rate asked for (0.45 / (1 - 0.5) = 0.9), leaving a tenth for rounding in the layers' sizes.
_FIRST_LAYER_SHARE = 0.45
_SEED_SALT = 0x9E3779B1


class ScalableBloomFilter:
    """Scalable Bloom Filter: a stack of Bloom Filters that grows with the set, so you need not know how many items there will be.

    It starts with one layer for `initial_capacity` items; when a layer holds as many items as it was sized for, a layer twice as big is added whose
    false-positive target is half as large. An item is present if any layer says so, so the layers' rates add up; with targets p, p / 2, p / 4, ... they
    sum to less than 2p, and the filter is sized with p = 0.45 x rate, so the rate stays under the one asked for however long the stream. It cannot remove
    items. A plain Bloom Filter sized right for the set needs less memory: this is for a set of unknown size. Size it with `size_scalable` in sizing.py.
    """

    def __init__(self, initial_capacity: int, false_positive_rate: float, seed: int = DEFAULT_SEED) -> None:
        if not (initial_capacity >= 1):
            raise ValueError("A Scalable Bloom Filter needs room for at least one item")
        if not (0 < false_positive_rate < 1):
            raise ValueError("The false-positive rate must be between 0 and 1")
        self.initial_capacity = int(initial_capacity)
        self.false_positive_target = false_positive_rate
        self.seed = seed
        self._layers = []
        self._capacities = []
        self._counts = []
        self._add_layer()

    def _add_layer(self) -> None:
        index = len(self._layers)
        capacity = self.initial_capacity * _GROWTH**index
        p = self.false_positive_target * _FIRST_LAYER_SHARE * _TIGHTENING**index  # the layers' targets add up to 0.9 of the target asked for
        bits = math.ceil(-capacity * math.log(p) / math.log(2) ** 2)
        hashes = max(1, math.floor(bits / capacity * math.log(2) + 0.5))  # round half up, as in the other languages
        self._layers.append(BloomFilter(bits, hashes, (self.seed + ((index + 1) * _SEED_SALT & 0xFFFFFFFF)) & 0xFFFFFFFF))
        self._capacities.append(capacity)
        self._counts.append(0)

    @property
    def layer_count(self) -> int:
        """The number of layers so far."""
        return len(self._layers)

    @property
    def memory_bits(self) -> int:
        """The memory it takes now, in bits."""
        return sum(layer.bits for layer in self._layers)

    def add(self, item: Item) -> None:
        """Adds an item. An item some layer already reports takes no room."""
        if self.might_contain(item):
            return
        if self._counts[-1] >= self._capacities[-1]:
            self._add_layer()
        self._layers[-1].add(item)
        self._counts[-1] += 1

    def might_contain(self, item: Item) -> bool:
        """False means certainly never added. True means probably added."""
        return any(layer.might_contain(item) for layer in self._layers)

    @property
    def false_positive_rate(self) -> float:
        """The chance that an item never added is reported: one minus the chance that no layer reports it."""
        clear = 1.0
        for layer in self._layers:
            clear *= 1 - layer.false_positive_rate()
        return 1 - clear
