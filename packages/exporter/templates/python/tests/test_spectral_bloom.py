import math

import pytest

from sizing import size_spectral
from src.spectral_bloom import SpectralBloom
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_spectral_bloom_filter_matches_the_reference_answers_counts_exactly_when_alone_takes_counts_back_and_stops_a_counter_at_its_top():
    v = vectors["spectral"]
    spectral = SpectralBloom(v["counters"], v["hashes"])
    for i in range(v["events"]):
        spectral.add(stream(i % v["distinct"]))
    for i in range(v["removed"]):
        spectral.remove(stream(i % 5))
    assert [spectral.estimate(stream(i)) for i in range(10)] == v["estimates"]
    assert [spectral.might_contain(stream(i + 30)) for i in range(40)] == v["present"]
    assert spectral.overshoot == v["overshoot"]
    assert spectral.false_positive_rate == v["falsePositiveRate"]

    alone = SpectralBloom(1024, 4)
    alone.add("apple", 5)
    assert alone.estimate("apple") == 5
    assert alone.might_contain("apple") is True
    alone.remove("apple", 5)
    assert alone.estimate("apple") == 0
    assert alone.might_contain("apple") is False  # forgotten, unlike a Bloom Filter
    assert alone.live_total == 0

    narrow = SpectralBloom(64, 3, counter_bits=4)  # counters stop at 15
    narrow.add("x", 40)
    assert narrow.estimate("x") == 15
    narrow.remove("x", 3)  # a stopped counter is left alone
    assert narrow.estimate("x") == 15
    with pytest.raises(ValueError):
        SpectralBloom(0, 3)
    with pytest.raises(ValueError):
        SpectralBloom(8, 3, counter_bits=1)


def test_statistical_never_undercounts_overshoots_the_band_no_more_often_than_e_to_the_minus_hashes_and_flags_a_never_added_item_no_more_often_than_the_stated_rate():
    sized = size_spectral(items=3000, error=0.02)
    under = over = total = false_yes = probes = 0
    reported = 0.0
    for t in range(TRIALS):
        rand = seeded_random(13000 + t)
        values = [random_u32(rand) for _ in range(200)]
        truth = {}
        spectral = SpectralBloom(sized["counters"], sized["hashes"])
        for _ in range(3000):
            value = values[int(200 * rand() ** 2)]  # a few heavy values
            spectral.add(value)
            truth[value] = truth.get(value, 0) + 1
        for value in values:
            diff = spectral.estimate(value) - truth.get(value, 0)
            under += diff < 0
            over += diff > spectral.overshoot
            total += 1
        reported += spectral.false_positive_rate
        for _ in range(200):
            probes += 1
            false_yes += spectral.might_contain(random_u32(rand))
    assert under == 0
    assert over / total <= math.exp(-sized["hashes"]), over / total
    assert false_yes / probes <= reported / TRIALS * 1.3 + 0.002, (false_yes / probes, reported / TRIALS)
