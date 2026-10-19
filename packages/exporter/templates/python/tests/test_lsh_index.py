import math

import pytest

from sizing import size_lsh
from src.lsh_index import LshIndex, band_rows_for, candidate_chance
from .helpers import random_u32, seeded_random, stream, vectors


def test_an_lsh_index_matches_the_reference_answers_finds_a_stored_set_alike_the_query_and_not_one_that_is_not_and_checks_its_candidates_with_min_hash():
    v = vectors["lsh"]
    assert band_rows_for(v["k"], v["threshold"], v["recall"]) == v["rows"]
    index = LshIndex(v["k"], v["threshold"], v["recall"])
    assert index.rows == v["rows"]
    assert index.bands == v["k"] // v["rows"]
    index.add("stream", [stream(i) for i in range(v["items"]["from"], v["items"]["to"])])
    for c in v["copies"]:
        copy = [stream(i) for i in range(c["from"], c["to"])]
        assert ("stream" in index.query(copy)) == c["candidate"], "copy %d to %d" % (c["from"], c["to"])

    many = LshIndex(128)
    for s in range(20):
        many.add("set-%d" % s, [1_000_000 * s + i for i in range(100)])
    many.add("overlap", [1_000_000 * 7 + 10 + i for i in range(100)])
    found = many.query([1_000_000 * 7 + i for i in range(100)])
    assert "set-7" in found and "overlap" in found
    assert len(found) == 2
    check = many.signature("set-7").similarity(many.signature("overlap"))
    assert 0.7 < check < 1
    assert many.query([]) == []
    with pytest.raises(ValueError):
        many.add("set-7", [1, 2, 3])
    with pytest.raises(ValueError):
        LshIndex(0)
    with pytest.raises(ValueError):
        LshIndex(64, 1.5)
    assert abs(candidate_chance(0.5, 2, 3) - (1 - 0.75**3)) < 1e-12
    assert band_rows_for(1, 0.6, 0.9) == 1


def test_statistical_sets_of_a_given_similarity_are_found_with_the_chance_one_minus_one_minus_s_to_the_rows_to_the_bands_and_a_pair_above_the_threshold_almost_always():
    trials = 60
    base = LshIndex(64)
    rows, bands = base.rows, base.bands
    for s in (0.3, 0.5, 0.7, 0.9):
        shared = round(200 * s / (1 + s))
        truth = shared / (200 - shared)
        found = 0
        for t in range(trials):
            rand = seeded_random(20000 + t)
            values = [random_u32(rand) for _ in range(200 - shared)]
            index = LshIndex(64, 0.6, 0.9, random_u32(rand))
            index.add("a", values[:100])
            if "a" in index.query(values[:shared] + values[100:]):
                found += 1
        chance = candidate_chance(truth, rows, bands)
        sigma = math.sqrt(chance * (1 - chance) / trials)
        assert abs(found / trials - chance) < 4 * sigma + 0.02, "similarity %s: found %s against %s" % (s, found / trials, chance)
        if s >= 0.7:
            assert found / trials >= 0.9
    sized = size_lsh(error=0.05)
    assert sized["recall"] >= 0.95 and sized["k"] == sized["rows"] * sized["bands"]
