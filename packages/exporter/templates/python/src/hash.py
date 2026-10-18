"""MurmurHash3 (x86, 32-bit) and the "enhanced double hashing" that derives k positions from two base hashes.

Everything here takes a seed, so the same data and seed give the same result in every language of this toolkit.
"""
from typing import List, Union

#: The seed used when none is given. Public on purpose; pass your own secret seed if inputs may be adversarial.
DEFAULT_SEED = 0x5BD1E995

_MASK = 0xFFFFFFFF
_C1 = 0xCC9E2D51
_C2 = 0x1B873593
_SECOND_HASH_SALT = 0x9E3779B9

Item = Union[int, str, bytes]


def _rotl32(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & _MASK


def _fmix32(h: int) -> int:
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & _MASK
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & _MASK
    h ^= h >> 16
    return h


def _mix_k(k: int) -> int:
    return (_rotl32((k * _C1) & _MASK, 15) * _C2) & _MASK


def _mix_h(h: int, k: int) -> int:
    return (_rotl32(h ^ k, 13) * 5 + 0xE6546B64) & _MASK


def hash_bytes(data: bytes, seed: int = 0) -> int:
    """Hashes bytes to an unsigned 32-bit integer."""
    h = seed & _MASK
    blocks = len(data) >> 2
    for i in range(blocks):
        k = int.from_bytes(data[4 * i : 4 * i + 4], "little")
        h = _mix_h(h, _mix_k(k))
    tail = data[blocks * 4 :]
    if tail:
        h ^= _mix_k(int.from_bytes(tail, "little"))
    return _fmix32(h ^ len(data))


def hash32(item: Item, seed: int = 0) -> int:
    """Hashes an item: a string by its UTF-8 bytes, an integer from 0 to 2^32 - 1 by its four little-endian bytes."""
    if isinstance(item, str):
        return hash_bytes(item.encode("utf-8"), seed)
    if isinstance(item, (bytes, bytearray)):
        return hash_bytes(bytes(item), seed)
    if isinstance(item, bool) or not isinstance(item, int) or item < 0 or item > _MASK:
        raise ValueError("A numeric item must be an integer from 0 to 2^32 - 1")
    return _fmix32(_mix_h(seed & _MASK, _mix_k(item)) ^ 4)


def positions(item: Item, k: int, modulus: int, seed: int = DEFAULT_SEED) -> List[int]:
    """The k positions in [0, modulus) of an item: h1 + i * h2 + (i^3 - i) / 6, all taken modulo the table size."""
    h1 = hash32(item, seed) % modulus
    h2 = hash32(item, (seed ^ _SECOND_HASH_SALT) & _MASK) % modulus
    return [(h1 + i * h2 + (((i * i * i - i) // 6) % modulus)) % modulus for i in range(k)]
