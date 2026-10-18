from .hash import DEFAULT_SEED, Item, positions


class BloomFilter:
    """Bloom Filter: answers "have I seen this?" in a fixed number of bits.

    It never says no for something that was added, and sometimes says yes for something that was not (a false
    positive). It cannot remove items. Size it with `size_bloom` in sizing.py.
    """

    def __init__(self, bits: int, hashes: int, seed: int = DEFAULT_SEED) -> None:
        if not (bits >= 1) or not (hashes >= 1):
            raise ValueError("A Bloom Filter needs at least one bit and one hash")
        self.bits = int(bits)
        self.hashes = int(hashes)
        self.seed = seed
        self._cells = bytearray((self.bits + 7) // 8)
        self._set_bits = 0

    def add(self, item: Item) -> None:
        for index in positions(item, self.hashes, self.bits, self.seed):
            mask = 1 << (index & 7)
            if not self._cells[index >> 3] & mask:
                self._cells[index >> 3] |= mask
                self._set_bits += 1

    def might_contain(self, item: Item) -> bool:
        """False means certainly never added. True means probably added."""
        return all(self._cells[i >> 3] & (1 << (i & 7)) for i in positions(item, self.hashes, self.bits, self.seed))

    @property
    def fill(self) -> float:
        """The share of bits that are set."""
        return self._set_bits / self.bits

    def false_positive_rate(self) -> float:
        """The false-positive rate right now, from how full the filter is."""
        return self.fill ** self.hashes
