import math

from .hash import DEFAULT_SEED, Item, hash32
from .registers import REGISTER_BITS, register_and_rank

_ALPHA_INFINITY = 0.39701


class LogLog:
    """LogLog: the simpler ancestor of HyperLogLog.

    It averages the registers' ranks instead of their reciprocals, so it needs about 1.3 / error^2 registers where
    HyperLogLog needs 1.04 / error^2. Prefer HyperLogLog unless you need the simpler arithmetic. Size it with
    `size_log_log`.
    """

    register_bits = REGISTER_BITS

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
        """Only sound once the stream has many more different items than registers."""
        m = self.size
        alpha = _ALPHA_INFINITY - (2 * math.pi ** 2 + math.log(2) ** 2) / (48 * m)
        return alpha * m * 2.0 ** (sum(self.registers) / m)

    @property
    def standard_error(self) -> float:
        """The expected relative standard error: 1.3 / sqrt(registers)."""
        return 1.3 / math.sqrt(self.size)
