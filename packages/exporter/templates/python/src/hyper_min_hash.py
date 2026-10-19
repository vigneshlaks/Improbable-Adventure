import math

from .hash import DEFAULT_SEED, Item, hash32

#: Bits of the position of the first one bit in a register.
_RANK_BITS = 5
#: Starts the synthetic items that measure how often unrelated registers agree.
_REFERENCE_BASE = 3_500_000_000


def _alpha(m: int) -> float:
    """HyperLogLog's bias correction for the harmonic mean."""
    return 0.7213 / (1 + 1.079 / m) if m >= 128 else 0.709 if m >= 64 else 0.697 if m >= 32 else 0.673


class HyperMinHash:
    """HyperMinHash (Yu and Weber): MinHash laid out like a HyperLogLog.

    A hash is cut into a bucket (the first `index_bits` bits), the position of the first one bit among the rest (as in HyperLogLog) and the `mantissa_bits` bits
    after that one; a register keeps the smallest hash of its bucket in that coded form, 5 + mantissa_bits bits. So there are 2^index_bits registers of 8 bits
    (against MinHash's 32-bit slots, about four times as many for the same memory), an add touches one register, and the same registers count the different
    items, as a HyperLogLog does.

    Two sets agree in a bucket when the smallest hash of their union is in both, which has the chance of their Jaccard similarity, or when two different
    smallest hashes happen to have the same code, which has a chance p that `similarity_to` measures: it builds a synthetic set of the other set's size from items
    nobody uses and counts how often its registers agree with these. Then (agreeing buckets / buckets either set uses - p) / (1 - p) estimates the similarity.
    Items cannot be removed. Size it with `size_hyper_min_hash` in sizing.py.
    """

    def __init__(self, index_bits: int, seed: int = DEFAULT_SEED, mantissa_bits: int = 3) -> None:
        if not isinstance(index_bits, int) or index_bits < 4 or index_bits > 20:
            raise ValueError("A HyperMinHash takes 4 to 20 index bits")
        if not isinstance(mantissa_bits, int) or mantissa_bits < 1 or mantissa_bits > 8:
            raise ValueError("The mantissa takes 1 to 8 bits")
        self.index_bits = index_bits
        self.mantissa_bits = mantissa_bits
        self.seed = seed
        self._registers = [0] * 2**index_bits

    @property
    def size(self) -> int:
        """The number of registers."""
        return 2**self.index_bits

    @property
    def memory_bits(self) -> int:
        """The memory they take."""
        return self.size * (_RANK_BITS + self.mantissa_bits)

    def _place(self, item: Item):
        """The bucket of an item and the code of its hash: the position and mantissa, arranged so that a larger code is a smaller hash. 0 is an empty register."""
        h = hash32(item, self.seed)
        bucket = h >> (32 - self.index_bits)
        rest = (h << self.index_bits) & 0xFFFFFFFF
        rank = min(2**_RANK_BITS - 1, 33 - self.index_bits if rest == 0 else (32 - rest.bit_length()) + 1)
        mantissa = 0 if rest == 0 or rank >= 32 else (((rest << rank) & 0xFFFFFFFF) >> (32 - self.mantissa_bits)) & (2**self.mantissa_bits - 1)
        return bucket, rank * 2**self.mantissa_bits + (2**self.mantissa_bits - 1 - mantissa) + 1

    def add(self, item: Item) -> None:
        bucket, code = self._place(item)
        if code > self._registers[bucket]:
            self._registers[bucket] = code

    def registers_of(self, items):
        """The registers of a set of items, made with this sketch's hash."""
        out = [0] * self.size
        for item in items:
            bucket, code = self._place(item)
            if code > out[bucket]:
                out[bucket] = code
        return out

    def _compare(self, other):
        """The buckets either side uses and the buckets where both agree."""
        used = agree = 0
        for mine, theirs in zip(self._registers, other):
            if mine == 0 and theirs == 0:
                continue
            used += 1
            agree += mine == theirs
        return used, agree

    def cardinality(self) -> float:
        """The estimated number of different items, as a HyperLogLog counts them from the position part of the registers (standard error about 1.04 / sqrt(registers))."""
        total = 0.0
        empty = 0
        for code in self._registers:
            if code == 0:
                empty += 1
                total += 1
            else:
                total += 2.0 ** -((code - 1) // 2**self.mantissa_bits)
        estimate = _alpha(self.size) * self.size * self.size / total
        return self.size * math.log(self.size / empty) if estimate <= 2.5 * self.size and empty > 0 else estimate

    def similarity_to(self, items):
        """The estimated Jaccard similarity of a set of items to the items added, with the agreement by chance taken out, and the numbers it was worked out from."""
        items = list(items)
        used, agree = self._compare(self.registers_of(items))
        reference = self.registers_of([_REFERENCE_BASE + i for i in range(max(1, len(set(items))))])
        ref_used, ref_agree = self._compare(reference)
        collision = 0.0 if ref_used == 0 else ref_agree / ref_used
        agree_share = 0.0 if used == 0 else agree / used
        return {"similarity": max(0.0, min(1.0, (agree_share - collision) / (1 - collision))), "collision": collision, "agreeShare": agree_share, "used": used}

    @property
    def standard_error(self) -> float:
        """The most the estimate is likely to be off, at one standard error: about 1 / (2 sqrt(registers)), a little more after the correction for chance agreements."""
        return 1 / (2 * math.sqrt(self.size))

    def merge(self, other: "HyperMinHash") -> "HyperMinHash":
        """The sketch of both sets together: the smaller hash in every bucket. Needs the same index bits, mantissa bits and seed."""
        if other.index_bits != self.index_bits or other.mantissa_bits != self.mantissa_bits or other.seed != self.seed:
            raise ValueError("HyperMinHashes merge only with the same shape and seed")
        merged = HyperMinHash(self.index_bits, self.seed, self.mantissa_bits)
        merged._registers = [max(a, b) for a, b in zip(self._registers, other._registers)]
        return merged
