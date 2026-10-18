import pytest

from sizing import size_linear_counting
from src.linear_counting import LinearCounting
from .helpers import TRIALS, coverage_floor, random_u32, seeded_random, stream, vectors


def test_a_linear_counting_matches_the_reference_answers_ignores_repeats_and_reports_saturation():
    v = vectors["linearCounting"]
    counter = LinearCounting(v["bits"])
    for i in range(v["items"]):
        counter.add(stream(i))
    assert abs(counter.estimate() - v["estimate"]) < 1e-9 * v["estimate"]
    before = counter.estimate()
    for i in range(v["items"]):
        counter.add(stream(i))
    assert counter.estimate() == before

    tiny = LinearCounting(8)
    for i in range(500):
        tiny.add(stream(i))
    assert tiny.saturated
    with pytest.raises(ValueError):
        LinearCounting(0)


def test_statistical_the_estimate_is_within_two_standard_errors_for_the_stated_share_of_streams():
    sized = size_linear_counting(distinct=5000, error=0.02)
    inside = 0
    for t in range(TRIALS):
        rand = seeded_random(5000 + t)
        counter = LinearCounting(sized["bits"])
        for _ in range(5000):
            counter.add(random_u32(rand))
        inside += abs(counter.estimate() - 5000) / 5000 <= 1.96 * counter.standard_error(5000)
    assert inside / TRIALS >= coverage_floor(0.95, TRIALS), inside / TRIALS
