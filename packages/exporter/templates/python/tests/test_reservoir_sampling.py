import pytest

from sizing import size_reservoir
from src.reservoir_sampling import ReservoirSampling
from .helpers import TRIALS, coverage_floor, seeded_random


def test_a_reservoir_keeps_everything_until_it_is_full_then_a_fixed_size_sample_and_is_repeatable_with_a_seeded_generator():
    small = ReservoirSampling(10, seeded_random(1))
    for i in range(7):
        small.add(i)
    assert small.sample() == [0, 1, 2, 3, 4, 5, 6]
    assert small.estimate_count(3) == 1
    for i in range(7, 1000):
        small.add(i)
    assert len(small.sample()) == 10
    assert small.seen == 1000
    again = ReservoirSampling(10, seeded_random(1))
    for i in range(1000):
        again.add(i)
    assert again.sample() == small.sample()
    with pytest.raises(ValueError):
        ReservoirSampling(0)


def test_statistical_the_share_estimated_from_a_sample_sized_for_five_percent_is_within_five_percent_at_the_stated_confidence():
    sized = size_reservoir(error=0.05)
    inside = 0
    for t in range(TRIALS):
        reservoir = ReservoirSampling(sized["sampleSize"], seeded_random(6000 + t))
        for i in range(5000):
            reservoir.add(i)
        inside += abs(reservoir.estimate_share(lambda item: item < 1500) - 0.3) <= 0.05  # the first 1,500 of 5,000 items
    assert inside / TRIALS >= coverage_floor(0.95, TRIALS), inside / TRIALS
