import pytest

from sizing import size_log_log
from src.log_log import LogLog
from .helpers import TRIALS, coverage_floor, random_u32, seeded_random, stream, vectors


def test_a_loglog_matches_the_reference_answers():
    for c in vectors["logLog"]:
        counter = LogLog(c["indexBits"])
        for i in range(c["items"]):
            counter.add(stream(i))
        assert abs(counter.estimate() - c["estimate"]) < 1e-6 * c["estimate"], c["items"]
    with pytest.raises(ValueError):
        LogLog(21)


def test_statistical_the_estimate_is_within_two_standard_errors_for_the_stated_share_of_streams():
    sized = size_log_log(distinct=50000, error=0.05)
    inside = 0
    for t in range(TRIALS):
        rand = seeded_random(4000 + t)
        counter = LogLog(sized["indexBits"])
        for _ in range(50000):
            counter.add(random_u32(rand))
        inside += abs(counter.estimate() - 50000) / 50000 <= 1.96 * counter.standard_error
    assert inside / TRIALS >= coverage_floor(0.95, TRIALS), inside / TRIALS
