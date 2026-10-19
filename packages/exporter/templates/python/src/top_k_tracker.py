import math

from .count_min_sketch import CountMinSketch
from .hash import DEFAULT_SEED, Item


def _key_of(item: Item):
    """A key that is the same for equal items."""
    return (type(item).__name__, bytes(item) if isinstance(item, (bytes, bytearray)) else item)


class TopKTracker:
    """Top-K Tracker: finds the heaviest items of a stream (heavy hitters) and keeps a tight interval around each one's count.

    A Count-Min Sketch ranks the items; a short list of `capacity` candidates keeps, for each, a lower and an upper bound on its count. An item joins the
    list when its sketch estimate beats the weakest candidate's upper bound (or the list is not full), with the interval the sketch gives at that moment: its
    estimate is an upper bound (the sketch never underestimates), and the estimate less the sketch's error band is a lower bound that holds with the sketch's
    confidence. After that every addition raises both ends by one and every removal lowers both, so an item that entered early, while the stream was small and
    the band narrow, keeps a narrow interval however big the stream grows. A heavy item enters early, so on a skewed stream the heavy items are answered far
    more tightly than the plain sketch could, and an item not on the list is answered by the sketch. Size it with `size_top_k` in sizing.py.
    """

    def __init__(self, width: int, depth: int, capacity: int, seed: int = DEFAULT_SEED) -> None:
        if not (capacity >= 1):
            raise ValueError("A Top-K Tracker needs room for at least one candidate")
        self.capacity = int(capacity)
        self._grid = CountMinSketch(width, depth, seed)
        self._entries = []  # dicts: item, low, high

    def _find(self, item: Item):
        key = _key_of(item)
        for entry in self._entries:
            if _key_of(entry["item"]) == key:
                return entry
        return None

    def add(self, item: Item) -> None:
        self._grid.add(item)
        entry = self._find(item)
        if entry is not None:
            entry["low"] += 1
            entry["high"] += 1
            return
        high = self._grid.estimate(item)
        low = min(high, max(1, math.floor(high - self._grid.overshoot)))  # it was just added, so at least one is live; rounded down, so still a bound
        if len(self._entries) < self.capacity:
            self._entries.append({"item": item, "low": low, "high": high})
            return
        weakest = self._entries[0]
        for candidate in self._entries:
            if candidate["high"] < weakest["high"]:
                weakest = candidate
        if high > weakest["high"]:
            self._entries[self._entries.index(weakest)] = {"item": item, "low": low, "high": high}

    def remove(self, item: Item) -> None:
        """Takes back an earlier addition. Only remove items that were added."""
        self._grid.remove(item)
        entry = self._find(item)
        if entry is None:
            return
        entry["low"] = max(0, entry["low"] - 1)
        entry["high"] = max(0, entry["high"] - 1)
        if entry["high"] == 0:
            self._entries = [candidate for candidate in self._entries if candidate is not entry]  # nothing of it is left: free the place

    def estimate(self, item: Item):
        """The count of an item as an interval: tight for an item on the list, the sketch's (never below the truth) for the rest."""
        entry = self._find(item)
        if entry is not None:
            return {"low": entry["low"], "high": entry["high"]}
        high = self._grid.estimate(item)
        return {"low": max(0, high - self._grid.overshoot), "high": high}

    def heavy_hitters(self):
        """The candidates, heaviest first."""
        ordered = sorted(self._entries, key=lambda e: -(e["high"] + e["low"]))
        return [dict(entry) for entry in ordered]
