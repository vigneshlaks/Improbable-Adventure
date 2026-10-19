import math

import pytest

from sizing import size_sim_hash
from src.sim_hash import SimHash
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_sim_hash_matches_the_reference_answers_sees_the_same_set_as_the_same_and_strangers_as_half_the_planes_apart_and_is_weak_on_duplicates():
    v = vectors["simHash"]
    sim = SimHash(v["planes"])
    for i in range(v["items"]):
        sim.add(stream(i))
    assert abs(sim.effective_size() - v["effectiveSize"]) < 1e-9 * v["effectiveSize"]
    for c in v["cases"]:
        copy = [stream(c["from"] + i) for i in range(c["to"] - c["from"])]
        assert sim.differing(copy) == c["differing"]
        assert abs(sim.similarity(copy) - c["similarity"]) < 1e-9, (c["from"], c["to"])
    same = [stream(i) for i in range(v["items"])]
    assert sim.differing(same) == 0
    assert sim.differing(same + same[:40]) == 0  # a repeated item in a set counts once

    # a stream where one item is added 150 times looks small: duplicates outweigh the rest
    repeats = SimHash(v["planes"])
    for i in range(v["items"]):
        repeats.add(stream(0 if i < 150 else i))
    assert abs(repeats.effective_size() - v["repeatsEffectiveSize"]) < 1e-9 * v["repeatsEffectiveSize"]
    assert repeats.effective_size() < 0.7 * sim.effective_size()
    assert SimHash(v["planes"]).effective_size() == 0

    assert abs(SimHash.similarity_at(0, 100, 100) - 1) < 1e-12
    assert abs(SimHash.similarity_at(1 / 3, 400, 400) - 200 / 600) < 1e-12  # cos 60 degrees = 0.5: shared 200, union 600
    with pytest.raises(ValueError):
        SimHash(48)


def test_statistical_the_share_of_planes_that_differ_has_the_mean_the_angle_gives_and_the_spread_of_a_binomial_over_the_planes():
    planes = size_sim_hash(error=0.03)["planes"]
    assert planes % 32 == 0
    for overlap in (0.2, 0.5, 0.8):
        # a stream of 200 items and a copy of 200 sharing `overlap` of them: cos = overlap, the share is acos(overlap) / pi
        shared = round(200 * overlap)
        expected = math.acos(shared / 200) / math.pi
        shares = []
        for t in range(TRIALS):
            rand = seeded_random(15000 + t)
            values = [random_u32(rand) for _ in range(400 - shared)]
            sim = SimHash(planes, random_u32(rand))
            for value in values[:200]:
                sim.add(value)
            shares.append(sim.differing(values[:shared] + values[200:]))
        mean = sum(shares) / TRIALS
        sd = math.sqrt(sum((x - mean) ** 2 for x in shares) / TRIALS)
        theory = math.sqrt(expected * (1 - expected) / planes)
        assert abs(mean - expected) < 4 * theory / math.sqrt(TRIALS) + 0.003, (mean, expected, overlap)
        assert theory * 0.6 < sd < theory * 1.2, (sd, theory, overlap)
        assert sd <= SimHash(planes).standard_error * 1.1, (sd, overlap)
