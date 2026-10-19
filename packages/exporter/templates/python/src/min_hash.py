import math

from .hash import DEFAULT_SEED, Item, hash32

_EMPTY = 2**32
#: Spaces out the seeds of the slots' hash functions.
_SLOT_SALT = 0x9E3779B1


class MinHash:
    """MinHash: estimates how alike two sets are (their Jaccard similarity: shared items over items in either) from a short signature.

    For each of k hash functions it keeps the smallest hash of any item added. Two sets agree on that minimum with exactly the chance of their
    similarity, so the share of slots where two signatures agree estimates it, with a standard error of at most 1 / (2 sqrt(k)). Adding an
    item again changes nothing, nothing can be removed, and the signature of two sets together is the smaller minimum in every slot. Both
    signatures must have the same k and seed. Size it with `size_min_hash` in sizing.py.
    """

    def __init__(self, k: int, seed: int = DEFAULT_SEED) -> None:
        if not (k >= 1):
            raise ValueError("A MinHash needs at least one slot")
        self.k = int(k)
        self.seed = seed
        self._minima = [_EMPTY] * self.k

    def _slot_seed(self, i: int) -> int:
        return (self.seed + (((i + 1) * _SLOT_SALT) & 0xFFFFFFFF)) & 0xFFFFFFFF

    @property
    def signature(self):
        """The smallest hash seen by each slot (2^32 for a slot that has seen nothing)."""
        return tuple(self._minima)

    def add(self, item: Item) -> None:
        for i in range(self.k):
            value = hash32(item, self._slot_seed(i))
            if value < self._minima[i]:
                self._minima[i] = value

    def similarity(self, other: "MinHash") -> float:
        """The estimated Jaccard similarity to another MinHash: the share of slots whose minima agree."""
        if other.k != self.k or other.seed != self.seed:
            raise ValueError("MinHashes compare only with the same k and seed")
        return sum(1 for a, b in zip(self._minima, other._minima) if a == b and a != _EMPTY) / self.k

    def merge(self, other: "MinHash") -> "MinHash":
        """The MinHash of both sets together."""
        if other.k != self.k or other.seed != self.seed:
            raise ValueError("MinHashes merge only with the same k and seed")
        merged = MinHash(self.k, self.seed)
        merged._minima = [min(a, b) for a, b in zip(self._minima, other._minima)]
        return merged

    @property
    def standard_error(self) -> float:
        """The most the estimate is likely to be off, at one standard error: 1 / (2 sqrt(k))."""
        return 1 / (2 * math.sqrt(self.k))
