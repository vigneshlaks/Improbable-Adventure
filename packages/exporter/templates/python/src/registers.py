"""What HyperLogLog and LogLog share: five-bit registers, each holding the longest run of leading zeros seen."""
from typing import Tuple

#: Bits in one register; a register holds a rank from 0 to 31.
REGISTER_BITS = 5
_MAX_RANK = 2 ** REGISTER_BITS - 1


def register_and_rank(hash_value: int, index_bits: int) -> Tuple[int, int]:
    """The register index and the rank (position of the first 1 bit) that a hash gives, for 2^index_bits registers."""
    index = hash_value >> (32 - index_bits)
    rest = (hash_value << index_bits) & 0xFFFFFFFF
    rank = 33 - index_bits if rest == 0 else 32 - rest.bit_length() + 1
    return index, min(_MAX_RANK, rank)
