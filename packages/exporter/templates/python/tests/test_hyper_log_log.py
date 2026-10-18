import pytest

from sizing import size_hyper_log_log
from src.hyper_log_log import HyperLogLog
from .helpers import TRIALS, coverage_floor, random_u32, seeded_random, stream, vectors


def test_a_hyperloglog_matches_the_reference_answers_ignores_repeats_merges_and_rejects_bad_sizes():
    for c in vectors["hyperLogLog"]:
        hll = HyperLogLog(c["indexBits"])
        for i in range(c["items"]):
            hll.add(stream(i))
        assert abs(hll.estimate() - c["estimate"]) < 1e-6 * c["estimate"], c["items"]

    repeated, once = HyperLogLog(8), HyperLogLog(8)
    for i in range(100):
        for _ in range(5):
            repeated.add(stream(i))
        once.add(stream(i))
    assert repeated.estimate() == once.estimate()

    left, right, both = HyperLogLog(10), HyperLogLog(10), HyperLogLog(10)
    for i in range(3000):
        (left if i % 2 == 0 else right).add(stream(i))
        both.add(stream(i))
    left.merge(right)
    assert left.estimate() == both.estimate()
    with pytest.raises(ValueError):
        left.merge(HyperLogLog(9))
    with pytest.raises(ValueError):
        HyperLogLog(3)


def test_statistical_the_estimate_is_within_two_standard_errors_for_the_stated_share_of_streams():
    sized = size_hyper_log_log(distinct=20000, error=0.02)
    inside = 0
    for t in range(TRIALS):
        rand = seeded_random(3000 + t)
        hll = HyperLogLog(sized["indexBits"])
        for _ in range(20000):
            hll.add(random_u32(rand))
        inside += abs(hll.estimate() - 20000) / 20000 <= 1.96 * hll.standard_error
    assert inside / TRIALS >= coverage_floor(0.95, TRIALS), inside / TRIALS
