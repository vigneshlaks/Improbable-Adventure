import pytest

from sizing import size_quotient
from src.quotient_filter import QuotientFilter
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_quotient_filter_matches_the_reference_answers_never_misses_an_item_it_took_forgets_what_is_removed_refuses_adds_when_full_and_merges():
    v = vectors["quotient"]
    quotient = QuotientFilter(v["quotientBits"], v["remainderBits"])
    for i in range(v["items"]):
        assert quotient.add(stream(i)) is True
    for i in range(v["removed"]):
        assert quotient.remove(stream(i * 3)) is True
    assert quotient.size == v["size"]
    assert quotient.false_positive_rate == v["falsePositiveRate"]
    for i, expected in enumerate(v["present"]):
        assert quotient.might_contain(stream(i * 4 + (i % 4))) == expected, "present %d" % i
    for i, expected in enumerate(v["outside"]):
        assert quotient.might_contain(stream(v["items"] + i)) == expected, "outside %d" % i
    assert quotient.memory_bits == 2 ** v["quotientBits"] * (v["remainderBits"] + 3)
    twice = QuotientFilter(v["quotientBits"], v["remainderBits"])
    twice.add("a")
    twice.add("a")
    twice.remove("a")  # one copy of the fingerprint goes, and the other stays
    assert twice.might_contain("a") is True
    assert twice.size == 1

    other = QuotientFilter(v["quotientBits"], v["remainderBits"])
    for i in range(v["merged"]["from"], v["merged"]["to"]):
        other.add(stream(i))
    merged = quotient.merge(other)
    assert merged.size == v["merged"]["size"]
    for i, expected in enumerate(v["merged"]["probes"]):
        assert merged.might_contain(stream(150 + i * 8)) == expected, "merged %d" % i
    assert quotient.size == v["size"]  # the originals are not changed
    with pytest.raises(ValueError):
        quotient.merge(QuotientFilter(v["quotientBits"], v["remainderBits"] - 1))

    small = QuotientFilter(4, 8)  # 16 slots
    for i in range(16):
        assert small.add(stream(i)) is True
    assert small.add(stream(99)) is False
    assert small.load == 1
    assert small.remove("never added") is False
    with pytest.raises(ValueError):
        QuotientFilter(1, 8)
    with pytest.raises(ValueError):
        QuotientFilter(20, 16)


def test_statistical_no_added_item_is_missed_and_a_never_added_item_is_reported_no_more_often_than_the_stated_rate():
    sized = size_quotient(items=2000, error=0.02)
    false_yes = probes = 0
    reported = 0.0
    for t in range(TRIALS):
        rand = seeded_random(12000 + t)
        quotient = QuotientFilter(sized["quotientBits"], sized["remainderBits"])
        added = set()
        for _ in range(2000):
            value = random_u32(rand)
            assert quotient.add(value) is True
            added.add(value)
        for value in added:
            assert quotient.might_contain(value)
        reported += quotient.false_positive_rate
        for _ in range(200):
            stranger = random_u32(rand)
            if stranger in added:
                continue
            probes += 1
            false_yes += quotient.might_contain(stranger)
    assert sized["falsePositiveRate"] <= 0.02
    assert false_yes / probes <= reported / TRIALS * 1.3 + 0.001, (false_yes / probes, reported / TRIALS)
    assert reported / TRIALS <= sized["falsePositiveRate"] * 1.01, (reported / TRIALS, sized["falsePositiveRate"])
