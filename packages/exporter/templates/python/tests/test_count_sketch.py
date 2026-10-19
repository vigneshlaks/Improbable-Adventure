import math

import pytest

from sizing import size_count_sketch
from src.count_sketch import CountSketch
from .helpers import TRIALS, coverage_floor, random_u32, seeded_random, stream, vectors


def test_a_count_sketch_matches_the_reference_answers_counts_exactly_when_alone_and_takes_counts_back_exactly():
    v = vectors["countSketch"]
    sketch = CountSketch(v["width"], v["depth"])
    for i in range(v["events"]):
        sketch.add(stream(i % v["distinct"]))
    for i in range(v["removed"]):
        sketch.remove(stream(i % 7))
    assert [sketch.raw_estimate(stream(i)) for i in range(10)] == v["estimates"]
    assert sketch.squared_norm == v["squaredNorm"]

    alone = CountSketch(1024, 5)
    alone.add("apple", 5)
    assert alone.estimate("apple") == 5
    assert abs(alone.error_band - 2 * 5 / math.sqrt(1024)) < 1e-12  # 2 x sqrt(25 / width)
    alone.remove("apple", 2)
    assert alone.estimate("apple") == 3
    alone.remove("apple", 3)
    assert alone.estimate("apple") == 0
    assert alone.squared_norm == 0  # nothing is left of it
    alone.remove("pear", 4)  # a count can go below zero, and the estimate is then clamped
    assert alone.raw_estimate("pear") == -4
    assert alone.estimate("pear") == 0


def test_statistical_the_estimate_is_within_error_times_l2_norm_of_the_truth_for_the_stated_share_of_queries_and_is_not_biased_to_one_side():
    sized = size_count_sketch(error=0.3)
    inside = total = below = above = 0
    for t in range(TRIALS):
        rand = seeded_random(8000 + t)
        values = [random_u32(rand) for _ in range(100)]
        truth = {}
        sketch = CountSketch(sized["width"], sized["depth"])
        for _ in range(1000):
            value = values[int(100 * rand() ** 2)]  # a few heavy values
            sketch.add(value)
            truth[value] = truth.get(value, 0) + 1
        norm = math.sqrt(sum(count * count for count in truth.values()))
        for value in values:
            diff = sketch.raw_estimate(value) - truth.get(value, 0)
            inside += abs(diff) <= sized["errorShare"] * norm
            below += diff < 0
            above += diff > 0
            total += 1
    assert inside / total >= coverage_floor(sized["confidence"], TRIALS), inside / total
    assert 0.25 < below / (below + above) < 0.75, below / (below + above)  # unbiased: errors go both ways
