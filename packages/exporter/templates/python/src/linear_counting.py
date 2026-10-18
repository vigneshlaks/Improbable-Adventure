import math

from .hash import DEFAULT_SEED, Item, hash32


class LinearCounting:
    """Linear Counting: estimates how many different items were added, with one bit per bucket.

    Accurate while the bit array is not close to full; it fails when every bit is set.
    Size it with `size_linear_counting` in sizing.py.
    """

    def __init__(self, bits: int, seed: int = DEFAULT_SEED) -> None:
        if not (bits >= 1):
            raise ValueError("Linear Counting needs at least one bit")
        self.bits = int(bits)
        self.seed = seed
        self._cells = bytearray((self.bits + 7) // 8)
        self._zeros = self.bits

    def add(self, item: Item) -> None:
        index = hash32(item, self.seed) % self.bits
        mask = 1 << (index & 7)
        if not self._cells[index >> 3] & mask:
            self._cells[index >> 3] |= mask
            self._zeros -= 1

    @property
    def saturated(self) -> bool:
        """True when every bit is set: the estimate is then only a lower limit."""
        return self._zeros == 0

    def estimate(self) -> float:
        """The estimated number of different items: -m ln(share of bits still zero)."""
        if self._zeros == 0:
            return self.bits * math.log(self.bits)
        return -self.bits * math.log(self._zeros / self.bits)

    def standard_error(self, count: float = None) -> float:
        """The expected standard error as a share of the true count, for an estimate of `count`."""
        count = self.estimate() if count is None else count
        load = count / self.bits
        return math.sqrt(self.bits * (math.exp(load) - load - 1)) / count
