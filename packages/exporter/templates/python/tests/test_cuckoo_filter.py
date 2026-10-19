import pytest

from sizing import size_cuckoo
from src.cuckoo_filter import CuckooFilter
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_cuckoo_filter_matches_the_reference_answers_never_forgets_what_it_took_forgets_what_is_removed_and_says_when_it_is_too_full():
    v = vectors["cuckoo"]
    cuckoo = CuckooFilter(v["buckets"], v["fingerprintBits"])
    for i in range(v["items"]):
        assert cuckoo.add(stream(i)) is True
    for i in range(v["removed"]):
        assert cuckoo.remove(stream(i * 5)) is True
    assert cuckoo.size == v["size"]
    for i, expected in enumerate(v["present"]):
        assert cuckoo.has(stream(i * 5 + (i % 5))) == expected, "present %d" % i
    for i, expected in enumerate(v["outside"]):
        assert cuckoo.has(stream(v["items"] + i)) == expected, "outside %d" % i

    small = CuckooFilter(4, 8)  # 16 places
    taken = [i for i in range(40) if small.add(stream(i))]
    assert 12 <= len(taken) <= 16, len(taken)
    assert len(taken) < 40  # some adds were refused
    assert small.remove("never added") is False
    with pytest.raises(ValueError):
        CuckooFilter(0, 8)
    with pytest.raises(ValueError):
        CuckooFilter(10, 17)


def test_statistical_no_added_item_is_missed_and_a_never_added_item_is_reported_no_more_often_than_the_stated_rate():
    sized = size_cuckoo(items=2000, error=0.02)
    false_yes = probes = 0
    for t in range(TRIALS):
        rand = seeded_random(9000 + t)
        cuckoo = CuckooFilter(sized["buckets"], sized["fingerprintBits"])
        added = set()
        for _ in range(2000):
            value = random_u32(rand)
            if cuckoo.add(value):
                added.add(value)
        assert len(added) >= 1990, len(added)
        missed = sum(1 for value in added if not cuckoo.has(value))
        assert missed <= 10, missed  # an add that dropped a fingerprint costs one earlier item
        for _ in range(200):
            stranger = random_u32(rand)
            if stranger in added:
                continue
            probes += 1
            false_yes += cuckoo.has(stranger)
    assert false_yes / probes <= sized["falsePositiveRate"] * 1.3, (false_yes / probes, sized["falsePositiveRate"])
