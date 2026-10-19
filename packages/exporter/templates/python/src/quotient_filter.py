from .hash import DEFAULT_SEED, Item, hash32

#: The bookkeeping bits each slot of a quotient filter carries beside its remainder: occupied, continuation and shifted.
_METADATA_BITS = 3


class QuotientFilter:
    """Quotient Filter: answers "have I seen this?" like a Bloom Filter, can forget, and merges.

    It splits a hash into a quotient (q bits), which picks an item's home slot in a table of 2^q slots, and a remainder (r bits), which is what the
    slot stores. Items with the same quotient form a sorted run and neighbouring runs push each other along; three bookkeeping bits per slot let a
    run be found again, so a slot costs r + 3 bits and the table 2^q (r + 3).

    This reference keeps the behaviour and not the packed layout: it holds the multiset of fingerprints (quotient and remainder, q + r bits), one per
    `add`, up to 2^q of them. A query says yes for an item whose fingerprint it holds, so a never-added item is a false yes with chance about
    (distinct fingerprints held) / 2^(q + r), the load times 2^-r. `remove` takes away one copy of the fingerprint, exactly. A full table refuses the
    next `add`. Two filters of the same shape and seed merge. Size it with `size_quotient` in sizing.py.
    """

    def __init__(self, quotient_bits: int, remainder_bits: int, seed: int = DEFAULT_SEED) -> None:
        if not isinstance(quotient_bits, int) or quotient_bits < 2 or quotient_bits > 24:
            raise ValueError("The quotient takes 2 to 24 bits")
        if not isinstance(remainder_bits, int) or remainder_bits < 1 or remainder_bits > 16 or quotient_bits + remainder_bits > 32:
            raise ValueError("The remainder takes 1 to 16 bits, and the quotient and remainder together at most 32")
        self.quotient_bits = quotient_bits
        self.remainder_bits = remainder_bits
        self.seed = seed
        self._fingerprints = {}
        self._entries = 0

    @property
    def slots(self) -> int:
        """The slots in the table."""
        return 2**self.quotient_bits

    @property
    def memory_bits(self) -> int:
        """The memory it takes: each slot is the remainder plus three bookkeeping bits."""
        return self.slots * (self.remainder_bits + _METADATA_BITS)

    @property
    def size(self) -> int:
        return self._entries

    @property
    def load(self) -> float:
        return self._entries / self.slots

    def _fingerprint(self, item: Item) -> int:
        return hash32(item, self.seed) >> (32 - self.quotient_bits - self.remainder_bits)

    def add(self, item: Item) -> bool:
        """Adds an item. Returns False if the table is full (the item is then not in the filter)."""
        if self._entries >= self.slots:
            return False
        fp = self._fingerprint(item)
        self._fingerprints[fp] = self._fingerprints.get(fp, 0) + 1
        self._entries += 1
        return True

    def remove(self, item: Item) -> bool:
        """Removes one copy of an item's fingerprint. Only remove items that were added: removing a stranger can remove a look-alike."""
        fp = self._fingerprint(item)
        held = self._fingerprints.get(fp, 0)
        if held == 0:
            return False
        if held == 1:
            del self._fingerprints[fp]
        else:
            self._fingerprints[fp] = held - 1
        self._entries -= 1
        return True

    def might_contain(self, item: Item) -> bool:
        """True if the item may have been added; False means it certainly was not (unless an `add` was refused when the table was full)."""
        return self._fingerprint(item) in self._fingerprints

    @property
    def false_positive_rate(self) -> float:
        """The chance that an item never added is reported: the distinct fingerprints held over all that exist."""
        return min(1.0, len(self._fingerprints) / 2 ** (self.quotient_bits + self.remainder_bits))

    def merge(self, other: "QuotientFilter") -> "QuotientFilter":
        """The filter of both streams: every fingerprint of each, as far as the slots go (the first `add` that finds no room is refused).
        Needs the same shape and seed."""
        if other.quotient_bits != self.quotient_bits or other.remainder_bits != self.remainder_bits or other.seed != self.seed:
            raise ValueError("Quotient filters merge only with the same shape and seed")
        merged = QuotientFilter(self.quotient_bits, self.remainder_bits, self.seed)
        for source in (self, other):
            for fp in sorted(source._fingerprints):
                for _ in range(source._fingerprints[fp]):
                    if merged._entries >= merged.slots:
                        return merged
                    merged._fingerprints[fp] = merged._fingerprints.get(fp, 0) + 1
                    merged._entries += 1
        return merged
