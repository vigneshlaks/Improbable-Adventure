from .hash import DEFAULT_SEED, Item, hash32

_BUCKET_SIZE = 4
_MAX_KICKS = 500
#: Mixed into the seed to get the hashes that make an item's fingerprint, the other bucket of a fingerprint, and the choice of what to push.
_FINGERPRINT_SALT = 0x85EBCA6B
_ALTERNATE_SALT = 0xC2B2AE35
_KICK_SALT = 0x27D4EB2F


class CuckooFilter:
    """Cuckoo Filter: answers "have I seen this?" like a Bloom Filter, and can also forget.

    It keeps a short fingerprint of every item in a table of buckets of four. An item's fingerprint can sit in one of two buckets (the one its
    hash picks, and a second that follows from the first and the fingerprint alone), so a fingerprint can be moved without knowing its item. A full
    pair of buckets pushes a fingerprint to its other bucket, and so on up to a limit, after which `add` gives up and returns False: the table is too
    full (above about 95 percent) and an item you believed was added is lost. A query says yes for an item whose fingerprint is in either bucket, so a
    never-added item is a false yes with chance about 8 / 2^fingerprint_bits at full load. Size it with `size_cuckoo` in sizing.py.
    """

    def __init__(self, buckets: int, fingerprint_bits: int, seed: int = DEFAULT_SEED) -> None:
        if not (buckets >= 1) or not isinstance(fingerprint_bits, int) or fingerprint_bits < 1 or fingerprint_bits > 16:
            raise ValueError("A Cuckoo Filter needs at least one bucket and a fingerprint of 1 to 16 bits")
        self.buckets = int(buckets)
        self.fingerprint_bits = fingerprint_bits
        self.seed = seed
        self._table = [0] * (self.buckets * _BUCKET_SIZE)
        self._entries = 0
        self._kicks = 0

    @property
    def capacity(self) -> int:
        return self.buckets * _BUCKET_SIZE

    @property
    def size(self) -> int:
        return self._entries

    @property
    def load(self) -> float:
        return self._entries / self.capacity

    def _fingerprint(self, item: Item) -> int:
        return hash32(item, (self.seed ^ _FINGERPRINT_SALT) & 0xFFFFFFFF) % (2**self.fingerprint_bits - 1) + 1  # never zero: zero marks an empty place

    def _bucket_of(self, item: Item) -> int:
        return hash32(item, self.seed) % self.buckets

    def _alternate(self, bucket: int, fingerprint: int) -> int:
        """The other bucket a fingerprint may sit in; applying it twice gives the bucket back."""
        h = hash32(fingerprint, (self.seed ^ _ALTERNATE_SALT) & 0xFFFFFFFF) % self.buckets
        return (h - bucket) % self.buckets

    def _slot_of(self, bucket: int, fingerprint: int) -> int:
        for i in range(_BUCKET_SIZE):
            if self._table[bucket * _BUCKET_SIZE + i] == fingerprint:
                return bucket * _BUCKET_SIZE + i
        return -1

    def _place(self, bucket: int, fingerprint: int) -> bool:
        slot = self._slot_of(bucket, 0)
        if slot < 0:
            return False
        self._table[slot] = fingerprint
        return True

    def add(self, item: Item) -> bool:
        """Adds an item. Returns False if the table was too full to take it (the item is then not in the filter)."""
        fp = self._fingerprint(item)
        first = self._bucket_of(item)
        second = self._alternate(first, fp)
        if self._place(first, fp) or self._place(second, fp):
            self._entries += 1
            return True
        held = fp
        bucket = first if hash32(self._kicks, (self.seed ^ _KICK_SALT) & 0xFFFFFFFF) % 2 == 0 else second
        for _ in range(_MAX_KICKS):
            choice = hash32(self._kicks, (self.seed ^ _KICK_SALT) & 0xFFFFFFFF) % _BUCKET_SIZE
            self._kicks += 1
            slot = bucket * _BUCKET_SIZE + choice
            pushed = self._table[slot]
            self._table[slot] = held
            held = pushed
            bucket = self._alternate(bucket, held)
            if self._place(bucket, held):
                self._entries += 1
                return True
        return False  # the fingerprint it still holds has nowhere to go: one earlier item is now forgotten

    def remove(self, item: Item) -> bool:
        """Removes one copy of an item's fingerprint. Only remove items that were added: removing a stranger can remove a look-alike."""
        fp = self._fingerprint(item)
        first = self._bucket_of(item)
        slot = self._slot_of(first, fp)
        if slot < 0:
            slot = self._slot_of(self._alternate(first, fp), fp)
        if slot < 0:
            return False
        self._table[slot] = 0
        self._entries -= 1
        return True

    def has(self, item: Item) -> bool:
        """True if the item may have been added; False means it certainly was not (unless a fingerprint was lost when the table was too full)."""
        fp = self._fingerprint(item)
        first = self._bucket_of(item)
        return self._slot_of(first, fp) >= 0 or self._slot_of(self._alternate(first, fp), fp) >= 0

    @property
    def false_positive_rate(self) -> float:
        """The chance that an item never added is reported: it needs one of the eight fingerprints in its two buckets to equal its own."""
        return 1 - (1 - 1 / (2**self.fingerprint_bits - 1)) ** (2 * _BUCKET_SIZE * self.load)
