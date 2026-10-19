import math

import pytest

from sizing import size_hyper_min_hash
from src.hyper_min_hash import HyperMinHash
from .helpers import random_u32, seeded_random, stream, vectors


def test_a_hyper_min_hash_matches_the_reference_answers_counts_the_different_items_sees_equal_sets_as_alike_and_strangers_as_strangers_and_merges():
    v = vectors["hyperMinHash"]
    sketch = HyperMinHash(v["indexBits"])
    for i in range(v["items"]):
        sketch.add(stream(i))
    assert [int(r) for r in sketch.registers_of([stream(i) for i in range(v["items"])])][: len(v["registers"])] == v["registers"]
    assert abs(sketch.cardinality() - v["cardinality"]) < 1e-9 * v["cardinality"]
    for c in v["cases"]:
        result = sketch.similarity_to([stream(i) for i in range(c["from"], c["to"])])
        assert abs(result["similarity"] - c["similarity"]) < 1e-9
        assert abs(result["collision"] - c["collision"]) < 1e-9
        assert result["used"] == c["used"]
    assert abs(sketch.cardinality() - v["items"]) / v["items"] < 4 * 1.04 / math.sqrt(sketch.size)
    assert sketch.memory_bits == 8 * 2 ** v["indexBits"]

    empty = HyperMinHash(v["indexBits"])
    assert empty.similarity_to([1, 2, 3])["similarity"] == 0
    assert empty.cardinality() == 0

    left, right, both = (HyperMinHash(v["indexBits"]) for _ in range(3))
    for i in range(1000):
        (left if i % 2 == 0 else right).add(stream(i))
        both.add(stream(i))
    assert abs(left.merge(right).cardinality() - both.cardinality()) < 1e-9 * both.cardinality()
    with pytest.raises(ValueError):
        left.merge(HyperMinHash(v["indexBits"] + 1))
    with pytest.raises(ValueError):
        HyperMinHash(3)
    assert HyperMinHash(8).standard_error == 1 / 32


def test_statistical_the_estimated_similarity_is_nearly_unbiased_and_its_spread_is_no_more_than_1_1_times_the_stated_standard_error():
    trials = 60
    sized = size_hyper_min_hash(error=0.05)
    for j in (0.2, 0.5, 0.8):
        shared = round(400 * j / (1 + j))
        truth = shared / (400 - shared)
        estimates = []
        for t in range(trials):
            rand = seeded_random(21000 + t)
            values = [random_u32(rand) for _ in range(400 - shared)]
            sketch = HyperMinHash(sized["indexBits"], random_u32(rand))
            for value in values[:200]:
                sketch.add(value)
            estimates.append(sketch.similarity_to(values[:shared] + values[200:])["similarity"])
        mean = sum(estimates) / trials
        sd = math.sqrt(sum((e - mean) ** 2 for e in estimates) / trials)
        assert sd <= sized["standardError"] * 1.2, "spread %s against %s at %s" % (sd, sized["standardError"], j)
        assert abs(mean - truth) <= 0.04, "mean %s against %s" % (mean, truth)
