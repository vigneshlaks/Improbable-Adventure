import math

import pytest

from sizing import size_min_hash
from src.min_hash import MinHash
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_min_hash_matches_the_reference_answers_sees_equal_sets_as_equal_and_strangers_as_strangers_ignores_repeats_and_merges():
    v = vectors["minHash"]
    left = MinHash(v["k"])
    right = MinHash(v["k"])
    for i in range(v["left"]["from"], v["left"]["to"]):
        left.add(stream(i))
    for i in range(v["right"]["from"], v["right"]["to"]):
        right.add(stream(i))
    assert list(left.signature)[: len(v["signature"])] == v["signature"]
    assert left.similarity(right) == v["similarity"]
    assert list(left.merge(right).signature)[: len(v["merged"])] == v["merged"]

    same = MinHash(v["k"])
    for _ in range(2):  # repeats change nothing
        for i in range(v["left"]["from"], v["left"]["to"]):
            same.add(stream(i))
    assert left.similarity(same) == 1
    stranger = MinHash(v["k"])
    for i in range(5000, 5300):
        stranger.add(stream(i))
    assert left.similarity(stranger) < 0.1
    assert MinHash(v["k"]).similarity(MinHash(v["k"])) == 0  # two empty sets agree on nothing
    assert MinHash(16).standard_error == 0.125  # 1 / (2 sqrt(16))
    with pytest.raises(ValueError):
        left.similarity(MinHash(v["k"] + 1))
    with pytest.raises(ValueError):
        MinHash(0)


def test_statistical_the_estimate_is_unbiased_and_its_spread_is_no_more_than_the_stated_standard_error_at_several_similarities():
    sized = size_min_hash(error=0.1)
    for j in (0.2, 0.5, 0.8):
        shared = round(400 * j / (1 + j))  # two sets of 200 sharing `shared`: J = shared / (400 - shared)
        truth = shared / (400 - shared)
        estimates = []
        for t in range(TRIALS):
            rand = seeded_random(11000 + t)
            values = [random_u32(rand) for _ in range(400 - shared)]
            a = MinHash(sized["k"])
            b = MinHash(sized["k"])
            for value in values[:200]:
                a.add(value)
            for value in values[:shared] + values[200:]:
                b.add(value)
            estimates.append(a.similarity(b))
        mean = sum(estimates) / TRIALS
        sd = math.sqrt(sum((x - mean) ** 2 for x in estimates) / TRIALS)
        assert sd <= sized["standardError"] * 1.1, (sd, j)
        assert abs(mean - truth) <= 4 * sized["standardError"] / math.sqrt(TRIALS), (mean, truth)
