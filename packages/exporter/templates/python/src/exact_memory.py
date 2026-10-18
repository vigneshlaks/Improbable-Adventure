from typing import Dict

from .hash import Item


class ExactMemory:
    """Exact Memory: a table of every distinct item and its count.

    No error at all, and memory grows with the number of different items. Use it when that is affordable, and as the
    truth to test the other structures against.
    """

    def __init__(self) -> None:
        self._counts: Dict[Item, int] = {}
        self._total = 0

    def add(self, item: Item, count: int = 1) -> None:
        self._counts[item] = self._counts.get(item, 0) + count
        self._total += count

    def remove(self, item: Item, count: int = 1) -> None:
        have = self._counts.get(item, 0)
        taken = min(have, count)
        if taken == have:
            self._counts.pop(item, None)
        else:
            self._counts[item] = have - taken
        self._total -= taken

    def count(self, item: Item) -> int:
        return self._counts.get(item, 0)

    @property
    def distinct(self) -> int:
        """The number of different items."""
        return len(self._counts)

    @property
    def total(self) -> int:
        """The number of items, counting repeats."""
        return self._total
