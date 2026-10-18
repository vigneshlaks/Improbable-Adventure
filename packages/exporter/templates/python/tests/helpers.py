import json
import math
import os
from typing import Callable

with open(os.path.join(os.path.dirname(__file__), "vectors.json"), encoding="utf-8") as handle:
    #: The known answers shared by every language of this toolkit, produced by the reference implementation.
    vectors = json.load(handle)

#: Seeded trials per statistical test.
TRIALS = 200


def stream(i: int) -> int:
    """The i-th value of the fixed test stream: spread across the 32-bit range, the same in every language."""
    return ((i + 1) * 2654435761) & 0xFFFFFFFF


def seeded_random(seed: int) -> Callable[[], float]:
    """A small seeded random generator (mulberry32), so statistical tests repeat exactly."""
    state = [seed & 0xFFFFFFFF]

    def next_value() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_value


def random_u32(rand: Callable[[], float]) -> int:
    return int(rand() * 4294967296)


def coverage_floor(confidence: float, trials: int) -> float:
    """Share of trials that must pass for a bound stated at `confidence`: the confidence minus three standard deviations of chance."""
    return confidence - 3 * math.sqrt(confidence * (1 - confidence) / trials)
