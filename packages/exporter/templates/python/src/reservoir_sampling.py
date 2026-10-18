import random as _random
from typing import Callable, List

from .hash import Item


class ReservoirSampling:
    """Reservoir Sampling: keeps a uniform random sample of fixed size from a stream of unknown length.

    Counts and shares are estimated from the sample. Pass your own `rand` (returning [0, 1)) for reproducible runs.
    Size it with `size_reservoir` in sizing.py.
    """

    def __init__(self, size: int, rand: Callable[[], float] = _random.random) -> None:
        if not (size >= 1):
            raise ValueError("A reservoir needs room for at least one item")
        self.size = int(size)
        self._kept: List[Item] = []
        self._seen = 0
        self._rand = rand

    def add(self, item: Item) -> None:
        self._seen += 1
        if len(self._kept) < self.size:
            self._kept.append(item)
            return
        j = int(self._rand() * self._seen)
        if j < self.size:
            self._kept[j] = item

    @property
    def seen(self) -> int:
        """How many items have been added."""
        return self._seen

    def sample(self) -> List[Item]:
        return list(self._kept)

    def estimate_count(self, item: Item) -> float:
        """The estimated number of times the item was added: its count in the sample scaled up to the stream."""
        return self._kept.count(item) * self._seen / max(1, len(self._kept))

    def estimate_share(self, test: Callable[[Item], bool]) -> float:
        """The estimated share of the stream that satisfies a test."""
        return 0.0 if not self._kept else sum(1 for x in self._kept if test(x)) / len(self._kept)
