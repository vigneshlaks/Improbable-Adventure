import math

from .hash import DEFAULT_SEED, Item, hash32
from .registers import register_and_rank

#: Below this many times the register count, counting empty registers is more accurate than the harmonic mean.
_SMALL_RANGE = 2.8


def _alpha(m: int) -> float:
    if m == 16:
        return 0.673
    if m == 32:
        return 0.697
    if m == 64:
        return 0.709
    return 0.7213 / (1 + 1.079 / m)


class HyperLogLog:
    """HyperLogLog: estimates how many different items were added, using 2^index_bits small registers.

    Standard error is about 1.04 / sqrt(registers). Memory does not grow with the stream. Size it with
    `size_hyper_log_log`. Items are hashed to 32 bits, so counts beyond a few hundred million lose accuracy.
    """

    def __init__(self, index_bits: int, seed: int = DEFAULT_SEED) -> None:
        if not isinstance(index_bits, int) or index_bits < 4 or index_bits > 20:
            raise ValueError("index_bits must be a whole number from 4 to 20")
        self.index_bits = index_bits
        self.seed = seed
        self.registers = [0] * (2 ** index_bits)

    @property
    def size(self) -> int:
        return len(self.registers)

    def add(self, item: Item) -> None:
        index, rank = register_and_rank(hash32(item, self.seed), self.index_bits)
        if rank > self.registers[index]:
            self.registers[index] = rank

    def estimate(self) -> float:
        m = self.size
        total = sum(2.0 ** -r for r in self.registers)
        empty = self.registers.count(0)
        if empty > 0 and m * math.log(m / empty) <= _SMALL_RANGE * m:
            return m * math.log(m / empty)  # small stream: count empty registers
        return _alpha(m) * m * m / total

    @property
    def standard_error(self) -> float:
        """The expected relative standard error: 1.04 / sqrt(registers)."""
        return 1.04 / math.sqrt(self.size)

    def merge(self, other: "HyperLogLog") -> None:
        """Combines another counter of the same size and seed, as if it had seen both streams."""
        if other.index_bits != self.index_bits or other.seed != self.seed:
            raise ValueError("Only counters of the same size and seed can merge")
        self.registers = [max(a, b) for a, b in zip(self.registers, other.registers)]
