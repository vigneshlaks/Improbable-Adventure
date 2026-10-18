import pytest

from sizing import size_bloom
from src.bloom_filter import BloomFilter
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_bloom_filter_matches_the_reference_answers_never_misses_an_added_item_and_rejects_bad_sizes():
    v = vectors["bloom"]
    f = BloomFilter(v["bits"], v["hashes"])
    for i in range(v["items"]):
        f.add(stream(i))
    assert abs(f.fill - v["fill"]) < 1e-12
    for i, expected in enumerate(v["probes"]):
        assert f.might_contain(stream(v["items"] + i)) == expected
    assert all(f.might_contain(stream(i)) for i in range(v["items"]))
    with pytest.raises(ValueError):
        BloomFilter(0, 3)


def test_statistical_a_filter_sized_for_one_percent_flags_at_most_1_3_percent_of_new_items():
    sized = size_bloom(items=1000, error=0.01)
    flagged = probes = 0
    for t in range(TRIALS):
        rand = seeded_random(1000 + t)
        f = BloomFilter(sized["bits"], sized["hashes"])
        for _ in range(1000):
            f.add(random_u32(rand))
        for _ in range(200):
            flagged += f.might_contain(random_u32(rand))
            probes += 1
    assert flagged / probes <= 0.01 * 1.3, flagged / probes
