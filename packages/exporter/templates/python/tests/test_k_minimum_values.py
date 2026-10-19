import pytest

from sizing import size_kmv
from src.k_minimum_values import KMinimumValues
from .helpers import TRIALS, coverage_floor, random_u32, seeded_random, stream, vectors


def test_k_minimum_values_matches_the_reference_answers_counts_exactly_while_small_ignores_repeats_and_merges():
    v = vectors["kmv"]
    sketch = KMinimumValues(v["k"])
    for i in range(v["items"]):
        sketch.add(stream(i))
    assert abs(sketch.count() - v["count"]) < 1e-6 * v["count"]
    assert list(sketch.hashes)[: len(v["hashes"])] == v["hashes"]

    small = KMinimumValues(v["k"])
    for i in range(v["small"]["items"]):
        small.add(stream(i))
    assert small.count() == v["small"]["count"]
    assert small.standard_error == 0
    for i in range(v["small"]["items"]):
        small.add(stream(i))  # repeats change nothing
    assert small.count() == v["small"]["count"]

    other = KMinimumValues(v["k"])
    for i in range(v["mergedWith"]["from"], v["mergedWith"]["to"]):
        other.add(stream(i))
    assert abs(sketch.merge(other).count() - v["mergedWith"]["count"]) < 1e-6 * v["mergedWith"]["count"]
    with pytest.raises(ValueError):
        sketch.merge(KMinimumValues(v["k"] + 1))
    with pytest.raises(ValueError):
        KMinimumValues(2)


def test_statistical_the_estimate_is_within_two_standard_errors_for_the_stated_share_of_streams():
    sized = size_kmv(error=0.05)
    inside = 0
    for t in range(TRIALS):
        rand = seeded_random(10000 + t)
        sketch = KMinimumValues(sized["k"])
        for _ in range(20000):
            sketch.add(random_u32(rand))
        if abs(sketch.count() - 20000) / 20000 <= 1.96 * sketch.standard_error:
            inside += 1
    assert inside / TRIALS >= coverage_floor(0.95, TRIALS), inside / TRIALS
