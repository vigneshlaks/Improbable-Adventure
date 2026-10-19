import math

import pytest

from sizing import size_dyadic
from src.dyadic_count_min import DyadicCountMin
from .helpers import coverage_floor, random_u32, seeded_random, stream, vectors


def test_a_dyadic_count_min_matches_the_reference_answers_takes_counts_back_and_ranks_values_in_order_without_ever_ranking_one_too_low():
    v = vectors["dyadic"]
    sketch = DyadicCountMin(v["bits"], v["width"], v["depth"])
    for i in range(v["items"]):
        sketch.add(stream(i))
    for i in range(v["removed"]):
        sketch.remove(stream(i))
    assert sketch.live_total == v["items"] - v["removed"]
    for q in v["quantiles"]:
        answer = sketch.quantile(q["quantile"])
        assert answer["estimate"] == q["estimate"], q["quantile"]
        assert answer["low"] == q["low"], q["quantile"]
        assert answer["high"] == (math.inf if q["high"] is None else q["high"]), q["quantile"]

    exact = DyadicCountMin(8, 4096, 3)  # wide sketches: nothing collides, so the counts are exact
    values = [stream(i) for i in range(200)]
    for value in values:
        exact.add(value)
    ordered = sorted(values)
    for probe in (ordered[0], ordered[50], ordered[100], ordered[199]):
        bucket = probe >> 24
        assert exact.rank(probe) == sum(1 for x in ordered if x >> 24 <= bucket)
    assert exact.rank(ordered[10]) <= exact.rank(ordered[150])  # ranks go up with the value
    assert exact.rank(0xFFFFFFFF) == 200
    assert DyadicCountMin(8, 64, 3).quantile(0.5) is None
    with pytest.raises(ValueError):
        exact.rank(-1)
    with pytest.raises(ValueError):
        DyadicCountMin(1, 8, 3)
    empty = DyadicCountMin(8, 64, 3)
    empty.remove(5)  # nothing to take back
    assert empty.live_total == 0


def test_statistical_the_rank_of_a_value_is_never_too_low_and_is_too_high_by_at_most_the_stated_band_for_the_stated_share_of_queries_the_sizing_plans_for_it():
    sized = size_dyadic(error=0.2)
    assert sized["bits"] == 32
    assert sized["rankError"] <= 0.2
    # 16 bits of the value keeps the test quick: 10 levels are sketches, each of width ceil(10 e / error) and a depth for a union bound over them
    width = math.ceil(10 * math.e / 0.2)
    depth = math.ceil(math.log(10 / (1 - 0.95)))
    under = over = total = 0
    trials = 60
    for t in range(trials):
        rand = seeded_random(18000 + t)
        sketch = DyadicCountMin(16, width, depth, random_u32(rand))
        values = [random_u32(rand) for _ in range(300)]
        for value in values:
            sketch.add(value)
        ordered = sorted(values)
        for _ in range(20):
            probe = values[int(rand() * len(values))]
            truth = sum(1 for x in ordered if x >> 16 <= probe >> 16)
            diff = sketch.rank(probe) - truth
            under += diff < 0
            over += diff > sketch.rank_overshoot
            total += 1
    assert under == 0
    assert over / total <= 1 - coverage_floor(0.95, trials) + 0.0001, over / total
