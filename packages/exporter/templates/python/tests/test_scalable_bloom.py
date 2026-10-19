import math

import pytest

from sizing import size_scalable
from src.bloom_filter import BloomFilter
from src.scalable_bloom import ScalableBloomFilter
from .helpers import TRIALS, random_u32, seeded_random


def test_a_scalable_bloom_filter_adds_a_layer_when_one_fills_never_misses_an_item_takes_no_room_for_a_repeat_and_rejects_bad_sizes():
    scalable = ScalableBloomFilter(100, 0.01)
    assert scalable.layer_count == 1
    first = scalable.memory_bits
    rand = seeded_random(1)
    items = [random_u32(rand) for _ in range(100)]
    for item in items:
        scalable.add(item)
    for item in items:
        scalable.add(item)  # repeats take no room
    assert scalable.layer_count == 1
    scalable.add(random_u32(rand))
    assert scalable.layer_count == 2  # the first layer was full
    assert scalable.memory_bits > first * 2
    assert all(scalable.might_contain(item) for item in items)
    for _ in range(1000):
        scalable.add(random_u32(rand))
    assert scalable.layer_count >= 4
    with pytest.raises(ValueError):
        ScalableBloomFilter(0, 0.01)
    with pytest.raises(ValueError):
        ScalableBloomFilter(10, 1)


def test_statistical_however_far_the_set_grows_past_the_first_guess_the_false_positive_rate_stays_under_the_one_asked_for_and_a_plain_filter_sized_for_the_first_guess_does_not():
    asked = 0.02
    sized = size_scalable(items=700, error=asked)
    assert sized["initialCapacity"] == 100
    false_yes = plain_false_yes = probes = 0
    reported = 0.0
    for t in range(TRIALS):
        rand = seeded_random(14000 + t)
        scalable = ScalableBloomFilter(sized["initialCapacity"], asked)
        plain = BloomFilter(math.ceil(-100 * math.log(asked) / math.log(2) ** 2), 6)  # sized for the first 100 items only
        added = set()
        for _ in range(700):
            value = random_u32(rand)
            scalable.add(value)
            plain.add(value)
            added.add(value)
        assert all(scalable.might_contain(value) for value in added)
        for _ in range(200):
            stranger = random_u32(rand)
            if stranger in added:
                continue
            probes += 1
            false_yes += scalable.might_contain(stranger)
            plain_false_yes += plain.might_contain(stranger)
        assert scalable.false_positive_rate <= asked, scalable.false_positive_rate
        reported += scalable.false_positive_rate
    assert false_yes / probes <= asked * 1.3, false_yes / probes
    assert false_yes / probes <= reported / TRIALS * 1.3 + 0.002, (reported / TRIALS, false_yes / probes)
    assert plain_false_yes / probes > 0.2, plain_false_yes / probes
