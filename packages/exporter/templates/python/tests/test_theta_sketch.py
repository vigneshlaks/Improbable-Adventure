import math

import pytest

from src.theta_sketch import ThetaSketch
from .helpers import random_u32, seeded_random, stream, vectors


def test_a_theta_sketch_matches_the_reference_answers_counts_exactly_while_small_and_combines_into_the_union_and_the_intersection():
    v = vectors["theta"]
    left, right = ThetaSketch(v["k"]), ThetaSketch(v["k"])
    for i in range(v["left"]["from"], v["left"]["to"]):
        left.add(stream(i))
    for i in range(v["right"]["from"], v["right"]["to"]):
        right.add(stream(i))
    assert left.theta == v["thetaLeft"]
    assert abs(left.count() - v["countLeft"]) < 1e-9 * v["countLeft"]
    assert abs(left.union(right).count() - v["countUnion"]) < 1e-9 * v["countUnion"]
    assert list(left.hashes)[: len(v["hashes"])] == v["hashes"]

    a, b = ThetaSketch(v["k"]), ThetaSketch(v["k"])
    for i in range(40):
        a.add(i)
    for i in range(20, 50):
        b.add(i)
    for i in range(40):
        a.add(i)
    assert a.theta == 1
    assert a.count() == 40
    assert a.union(b).count() == 50
    assert a.intersection_count(b) == 20
    assert left.union(right).count() > left.count()
    with pytest.raises(ValueError):
        a.union(ThetaSketch(v["k"] + 1))
    with pytest.raises(ValueError):
        a.intersection_count(ThetaSketch(v["k"], 5))


def test_statistical_the_union_and_the_intersection_are_estimated_without_bias_and_with_the_spread_the_sample_size_gives():
    trials = 60
    k, only = 256, 2000
    unions, intersections = [], []
    for t in range(trials):
        rand = seeded_random(22000 + t)
        seed = random_u32(rand)
        values = [random_u32(rand) for _ in range(3 * only)]
        left, right = ThetaSketch(k, seed), ThetaSketch(k, seed)
        for v in values[: 2 * only]:
            left.add(v)
        for v in values[only:]:
            right.add(v)
        unions.append(left.union(right).count())
        intersections.append(left.intersection_count(right))

    def stats(xs):
        mean = sum(xs) / len(xs)
        return mean, math.sqrt(sum((x - mean) ** 2 for x in xs) / len(xs))

    mean, sd = stats(unions)
    assert abs(mean - 3 * only) / (3 * only) < 0.02
    assert sd / (3 * only) <= (1 / math.sqrt(k - 2)) * 1.2
    mean, sd = stats(intersections)
    expected = math.sqrt(3 * only / k - 1) / math.sqrt(only)
    assert abs(mean - only) / only < 4 * expected / math.sqrt(trials)
    assert expected * 0.6 <= sd / only <= expected * 1.3
