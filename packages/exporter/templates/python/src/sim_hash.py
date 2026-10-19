import math

from .hash import DEFAULT_SEED, Item, hash32

#: Spaces out the seeds of the hash functions that give the planes' signs.
_GROUP_SALT = 0x9E3779B1


class SimHash:
    """SimHash: how alike two sets are, from the angle between them, read off a fingerprint of signs.

    Each of `planes` random planes gives every item a sign (a bit of its hash), and keeps a counter of the signs of the items added. The fingerprint is
    the sign of each counter. A set of items gets its own signs the same way, and the share of planes where the two disagree estimates the angle between
    them divided by pi, with the spread of a binomial over the planes. The cosine of that angle is shared / sqrt(size of one x size of the other) for
    sets, so with the two sizes the Jaccard similarity follows.

    It is rough, and weak on duplicates: it cannot count different items, so it takes the stream's size as its effective number of values, n^2 over the
    mean squared counter (exact when every item is added equally often, too small when a few are added a lot, which then look less like their copies than
    they are). It cannot remove items. `planes` is a multiple of 32. Size it with `size_sim_hash` in sizing.py.
    """

    def __init__(self, planes: int, seed: int = DEFAULT_SEED, counter_bits: int = 16) -> None:
        if not isinstance(planes, int) or planes < 32 or planes % 32 != 0:
            raise ValueError("SimHash needs a multiple of 32 planes, at least 32")
        if not isinstance(counter_bits, int) or counter_bits < 4 or counter_bits > 31:
            raise ValueError("A counter takes 4 to 31 bits")
        self.planes = planes
        self.seed = seed
        self._cap = 2 ** (counter_bits - 1) - 1
        self._counters = [0] * planes
        self._added = 0

    def _signs(self, item: Item):
        """The signs an item gives the planes: +1 or -1 for each."""
        out = []
        for group in range(self.planes // 32):
            value = hash32(item, (self.seed + ((group + 1) * _GROUP_SALT & 0xFFFFFFFF)) & 0xFFFFFFFF)
            out.extend(1 if (value >> bit) & 1 else -1 for bit in range(32))
        return out

    def add(self, item: Item) -> None:
        self._added += 1
        signs = self._signs(item)
        self._counters = [max(-self._cap, min(self._cap, c + s)) for c, s in zip(self._counters, signs)]

    def effective_size(self) -> float:
        """The effective number of values added: n^2 over the mean squared counter."""
        if self._added == 0:
            return 0
        mean_square = sum(c * c for c in self._counters) / self.planes
        return self._added if mean_square <= 0 else max(1.0, min(float(self._added), self._added**2 / mean_square))

    def differing(self, items) -> float:
        """The share of planes whose sign differs between the stream and a set of items: the estimate of their angle divided by pi."""
        sums = [0] * self.planes
        for item in set(items):  # a set counts each item once
            signs = self._signs(item)
            sums = [a + b for a, b in zip(sums, signs)]
        differ = sum(1 for c, s in zip(self._counters, sums) if (c >= 0) != (s >= 0))
        return differ / self.planes

    def similarity(self, items) -> float:
        """The estimated Jaccard similarity of a set of items to the stream, from the angle and the two sizes."""
        return SimHash.similarity_at(self.differing(items), self.effective_size(), len(set(items)))

    @staticmethod
    def similarity_at(share: float, stream_size: float, copy_size: float) -> float:
        """The Jaccard similarity that goes with an angle (as a share of pi), for a stream of `stream_size` values and a copy of `copy_size`."""
        shared = max(0.0, min(stream_size, copy_size, math.cos(math.pi * share) * math.sqrt(stream_size * copy_size)))
        union = stream_size + copy_size - shared
        return 1.0 if union <= 0 else shared / union

    @property
    def standard_error(self) -> float:
        """The most the angle's share is likely to be off, at one standard error: sqrt(p (1 - p) / planes), at most 1 / (2 sqrt(planes))."""
        return 1 / (2 * math.sqrt(self.planes))
