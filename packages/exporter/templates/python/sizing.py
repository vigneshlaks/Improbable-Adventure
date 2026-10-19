"""Sizing calculator: your real workload in, parameters out.

Every function takes keyword arguments items, distinct, error and memory_bits (any may be left out) and returns a
dict with the parameters to construct the structure with, the error they give and the memory they take.
  - give `error`: the smallest memory that reaches it is chosen;
  - give `memory_bits`: the error that memory gives is reported;
  - give both: the memory is used and `meets_target` says whether the error was reached;
  - give neither: a default target of 1% is used.
Errors are relative (0.01 is 1%). Probabilistic bounds hold at CONFIDENCE.
"""
import math
from typing import Dict, Optional, Union

CONFIDENCE = 0.95
DEFAULT_ERROR = 0.01
VALUE_BITS = 32
COUNTER_BITS = 32
REGISTER_BITS = 5
HLL_ERROR_COEFFICIENT = 1.04
LOGLOG_ERROR_COEFFICIENT = 1.3
#: The fewest index bits a register structure is sized to (16 registers).
MIN_INDEX_BITS = 4
#: The most bits a search will try, which stops a target that cannot be met from looping.
MAX_BITS = 2 ** 50

Sized = Dict[str, Union[int, float, bool]]


def _need(name: str, value: Optional[float]) -> float:
    if value is None or not value > 0:
        raise ValueError("The workload needs %s, a positive number" % name)
    return value


def _target(error: Optional[float]) -> float:
    if error is None:
        return DEFAULT_ERROR
    if not 0 < error < 1:
        raise ValueError("The acceptable error must be between 0 and 1")
    return error


def _meets(error: Optional[float], achieved: float) -> bool:
    return error is None or achieved <= error


def size_bloom(items: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    n = _need("items", items)

    def rate_for(bits: int):
        hashes = max(1, math.floor(bits / n * math.log(2) + 0.5))  # round half up, as in the other languages
        return hashes, (1 - math.exp(-hashes * n / bits)) ** hashes

    bits = memory_bits
    if bits is None:
        wanted = _target(error)
        bits = math.ceil(-n * math.log(wanted) / math.log(2) ** 2)
        while rate_for(bits)[1] > wanted:  # the hash count is a whole number, which can leave the formula's size a hair short
            bits += 1
    hashes, rate = rate_for(bits)
    return {"bits": bits, "hashes": hashes, "falsePositiveRate": rate, "memoryBits": bits, "meetsTarget": _meets(error, rate)}


def size_count_min(items: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    depth = max(1, math.ceil(math.log(1 / (1 - CONFIDENCE))))
    if memory_bits is not None:
        width = max(1, math.floor(memory_bits / (depth * COUNTER_BITS)))
    else:
        width = math.ceil(math.e / _target(error))
    error_share = math.e / width
    return {
        "width": width,
        "depth": depth,
        "errorShare": error_share,
        "overshoot": error_share * (items or 0),
        "confidence": 1 - math.exp(-depth),
        "memoryBits": width * depth * COUNTER_BITS,
        "meetsTarget": _meets(error, error_share),
    }


def _size_registers(coefficient: float, error: Optional[float], memory_bits: Optional[float]) -> Sized:
    if memory_bits is not None:
        index_bits = math.floor(math.log2(memory_bits / REGISTER_BITS))
    else:
        index_bits = math.ceil(math.log2((coefficient / _target(error)) ** 2))
    index_bits = max(MIN_INDEX_BITS, index_bits)
    registers = 2 ** index_bits
    standard_error = coefficient / math.sqrt(registers)
    return {
        "indexBits": index_bits,
        "registers": registers,
        "standardError": standard_error,
        "memoryBits": registers * REGISTER_BITS,
        "meetsTarget": _meets(error, standard_error),
    }


def size_hyper_log_log(distinct: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    return _size_registers(HLL_ERROR_COEFFICIENT, error, memory_bits)


def size_log_log(distinct: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    return _size_registers(LOGLOG_ERROR_COEFFICIENT, error, memory_bits)


def _linear_error(n: float, m: float) -> float:
    """Standard error of Linear Counting for n different items in m bits: sqrt(m (e^t - t - 1)) / n with t = n / m."""
    load = n / m
    return math.sqrt(m * (math.exp(load) - load - 1)) / n


def size_linear_counting(distinct: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    n = _need("distinct", distinct)
    if memory_bits is not None:
        bits = max(1, math.floor(memory_bits))
    else:
        wanted = _target(error)
        low, high = 1, max(2, math.ceil(n))
        while _linear_error(n, high) > wanted:
            high *= 2
            if high > MAX_BITS:
                raise ValueError("No bit array reaches that error for this many different items")
        while low < high:
            mid = (low + high) // 2
            if _linear_error(n, mid) <= wanted:
                high = mid
            else:
                low = mid + 1
        bits = low
    standard_error = _linear_error(n, bits)
    return {"bits": bits, "standardError": standard_error, "memoryBits": bits, "meetsTarget": _meets(error, standard_error)}


def _z_for(confidence: float) -> float:
    """The two-sided normal quantile for a confidence (1.96 for 95%), found by bisection on the error function."""

    def erf(x: float) -> float:
        # Abramowitz and Stegun 7.1.26, accurate to 1.5e-7.
        t = 1 / (1 + 0.3275911 * abs(x))
        poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
        return math.copysign(1 - poly * math.exp(-x * x), x)

    low, high = 0.0, 10.0
    for _ in range(60):
        mid = (low + high) / 2
        if erf(mid / math.sqrt(2)) < confidence:
            low = mid
        else:
            high = mid
    return high


def size_reservoir(items: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    z = _z_for(CONFIDENCE)
    if memory_bits is not None:
        sample_size = max(1, math.floor(memory_bits / VALUE_BITS))
    else:
        sample_size = math.ceil(z * z * 0.25 / _target(error) ** 2)
    achieved = z * 0.5 / math.sqrt(sample_size)
    return {"sampleSize": sample_size, "error": achieved, "memoryBits": sample_size * VALUE_BITS, "meetsTarget": _meets(error, achieved)}


def size_exact(distinct: float = None, memory_bits: float = None, **_: object) -> Sized:
    """Exact Memory keeps every different item and a counter for it: no error, and the most memory."""
    entries = math.ceil(_need("distinct", distinct))
    memory = entries * (VALUE_BITS + COUNTER_BITS)
    return {"entries": entries, "memoryBits": memory, "meetsTarget": memory_bits is None or memory <= memory_bits}


def size_count_sketch(error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """Count Sketch: a row's error exceeds epsilon x L2 norm with probability at most 1 / (width x epsilon^2) (Chebyshev), so width = 4 / epsilon^2
    makes a row wrong with probability at most 1/4, and the median of an odd number of rows is wrong only if half of them are, which has probability
    at most e^(-depth x D) with D = (1/2) ln 2 + (1/2) ln (2/3). The depth is the smallest odd one with that under 1 - confidence. Given a memory
    budget, the width is what fits and epsilon is 2 / sqrt(width)."""
    entropy = 0.5 * math.log(2) + 0.5 * math.log(2 / 3)
    depth = max(1, math.ceil(math.log(1 / (1 - CONFIDENCE)) / entropy))
    if depth % 2 == 0:
        depth += 1
    if memory_bits is not None:
        width = max(1, math.floor(memory_bits / (depth * COUNTER_BITS)))
    else:
        width = math.ceil(4 / _target(error) ** 2)
    achieved = 2 / math.sqrt(width)
    return {"width": width, "depth": depth, "errorShare": achieved, "confidence": CONFIDENCE, "memoryBits": width * depth * COUNTER_BITS, "meetsTarget": _meets(error, achieved)}


#: A Cuckoo Filter's buckets hold four fingerprints, and it works up to about this share full.
CUCKOO_BUCKET_SIZE = 4
CUCKOO_MAX_LOAD = 0.95


def size_cuckoo(items: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """False positives are about 2 x bucket size / 2^f at full load: f = ceil(log2(8 / error)). Given memory, the fingerprint is what fits."""
    n = _need("items", items)
    buckets = math.ceil(n / (CUCKOO_BUCKET_SIZE * CUCKOO_MAX_LOAD))
    if memory_bits is not None:
        fingerprint_bits = min(16, max(1, math.floor(memory_bits / (buckets * CUCKOO_BUCKET_SIZE))))
    else:
        fingerprint_bits = min(16, max(1, math.ceil(math.log2(2 * CUCKOO_BUCKET_SIZE / _target(error)))))
    rate = 2 * CUCKOO_BUCKET_SIZE / 2**fingerprint_bits
    return {"buckets": buckets, "fingerprintBits": fingerprint_bits, "falsePositiveRate": rate, "memoryBits": buckets * CUCKOO_BUCKET_SIZE * fingerprint_bits, "meetsTarget": _meets(error, rate)}


def size_kmv(error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """K-Minimum Values: relative standard error 1 / sqrt(k - 2), so k = 1 / error^2 + 2, at 32 bits a hash."""
    if memory_bits is not None:
        k = max(3, math.floor(memory_bits / VALUE_BITS))
    else:
        k = math.ceil(1 / _target(error) ** 2) + 2
    achieved = 1 / math.sqrt(k - 2)
    return {"k": k, "standardError": achieved, "memoryBits": k * VALUE_BITS, "meetsTarget": _meets(error, achieved)}


def size_min_hash(error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """MinHash: standard error at most 1 / (2 sqrt(k)), so k = 1 / (4 error^2), at 32 bits a slot."""
    if memory_bits is not None:
        k = max(1, math.floor(memory_bits / VALUE_BITS))
    else:
        k = math.ceil(1 / (4 * _target(error) ** 2))
    achieved = 1 / (2 * math.sqrt(k))
    return {"k": k, "standardError": achieved, "memoryBits": k * VALUE_BITS, "meetsTarget": _meets(error, achieved)}


#: A Quotient Filter is run up to this share full.
QUOTIENT_MAX_LOAD = 0.9


def size_quotient(items: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """q = ceil(log2(items / 0.9)); false positives are the load times 2^-r, so r = ceil(log2(load / error)); the table is 2^q (r + 3) bits. Given memory, r is what fits."""
    n = _need("items", items)
    quotient_bits = max(2, math.ceil(math.log2(n / QUOTIENT_MAX_LOAD)))
    slots = 2**quotient_bits
    load = n / slots
    if memory_bits is not None:
        remainder_bits = min(16, max(1, math.floor(memory_bits / slots) - 3))
    else:
        remainder_bits = min(16, max(1, math.ceil(math.log2(load / _target(error)))))
    rate = load * 2.0**-remainder_bits
    return {"quotientBits": quotient_bits, "remainderBits": remainder_bits, "slots": slots, "falsePositiveRate": rate, "memoryBits": slots * (remainder_bits + 3), "meetsTarget": _meets(error, rate)}


#: The bits of a Spectral Bloom Filter's counter, as in the game.
SPECTRAL_COUNTER_BITS = 16


def size_spectral(items: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """A Bloom filter's size for the false-positive rate, in 16-bit counters; a count overshoots by at most e k N / counters."""
    n = _need("items", items)

    def rate_for(counters: int):
        hashes = max(1, math.floor(counters / n * math.log(2) + 0.5))  # round half up, as in the other languages
        return hashes, (1 - math.exp(-hashes * n / counters)) ** hashes

    if memory_bits is not None:
        counters = max(1, math.floor(memory_bits / SPECTRAL_COUNTER_BITS))
    else:
        wanted = _target(error)
        counters = math.ceil(-n * math.log(wanted) / math.log(2) ** 2)
        while rate_for(counters)[1] > wanted:
            counters += 1
    hashes, rate = rate_for(counters)
    return {"counters": counters, "hashes": hashes, "falsePositiveRate": rate, "overshootShare": math.e * hashes / counters, "memoryBits": counters * SPECTRAL_COUNTER_BITS, "meetsTarget": _meets(error, rate)}


def size_scalable(items: float = None, error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """A Scalable Bloom Filter for an expected number of items: the first layer holds a seventh of them, so three layers (1 + 2 + 4 sevenths) hold them all;
    it grows past that on its own."""
    n = _need("items", items)
    rate = _target(error)
    initial_capacity = max(1, math.ceil(n / 7))
    layers = 1
    while initial_capacity * (2**layers - 1) < n:
        layers += 1
    bits = 0
    for i in range(layers):
        capacity = initial_capacity * 2**i
        bits += math.ceil(-capacity * math.log(rate * 0.45 * 0.5**i) / math.log(2) ** 2)
    return {"initialCapacity": initial_capacity, "falsePositiveRate": rate, "layers": layers, "memoryBits": bits, "meetsTarget": memory_bits is None or bits <= memory_bits}


#: The bits of a SimHash counter, as in the game.
SIMHASH_COUNTER_BITS = 16


def size_sim_hash(error: float = None, memory_bits: float = None, **_: object) -> Sized:
    """The share of planes that disagree has a standard error of at most 1 / (2 sqrt(planes)), so planes = 1 / (4 error^2), rounded up to a multiple of 32;
    a counter is 16 bits."""
    if memory_bits is not None:
        planes = max(32, math.floor(memory_bits / SIMHASH_COUNTER_BITS / 32) * 32)
    else:
        planes = max(32, math.ceil(1 / (4 * _target(error) ** 2) / 32) * 32)
    achieved = 1 / (2 * math.sqrt(planes))
    return {"planes": planes, "standardError": achieved, "memoryBits": planes * SIMHASH_COUNTER_BITS, "meetsTarget": _meets(error, achieved)}
