import pytest

from sizing import size_kll
from src.kll_sketch import KllSketch
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_kll_sketch_matches_the_reference_answers_is_exact_while_small_ignores_nothing_it_was_given_and_merges():
    v = vectors["kll"]
    sketch = KllSketch(v["k"])
    for i in range(v["items"]):
        sketch.add(stream(i))
    assert len(sketch.items) == v["stored"]
    for q in v["quantiles"]:
        assert sketch.quantile(q["quantile"]) == q["value"], q["quantile"]
    for r in v["ranks"]:
        assert sketch.rank(r["value"]) == r["rank"], r["value"]
    assert sketch.count == v["items"]

    small = KllSketch(v["k"])  # fewer items than fit in the lowest level: nothing is dropped
    for i in range(1, 31):
        small.add(i * 10)
    assert small.quantile(0.5) == 150
    assert small.quantile(1) == 300
    assert small.quantile(0.01) == 10
    assert small.rank(150) == 0.5
    assert KllSketch(v["k"]).quantile(0.5) is None
    seven = KllSketch(v["k"])
    for i in range(1, 8):
        seven.add(i)
    assert seven.quantile(0.5) == 4  # the 3.5th item is reached at the 4th

    left, right = KllSketch(v["k"]), KllSketch(v["k"])
    for i in range(5000):
        (left if i % 2 == 0 else right).add(stream(i))
    both = left.merge(right)
    assert both.count == 5000
    assert sum(weight for _, weight in both.items) == 5000  # every item is accounted for
    assert len(both.items) <= 3 * v["k"] + 30, len(both.items)  # the merge was compacted
    assert len(both.items) < len(left.items) + len(right.items)
    assert left.count == 2500  # the originals are not changed
    with pytest.raises(ValueError):
        left.merge(KllSketch(v["k"] + 1))
    with pytest.raises(ValueError):
        KllSketch(1)
    with pytest.raises(ValueError):
        small.add(float("nan"))
    assert KllSketch(10).rank_error == 0.16


def test_statistical_the_rank_error_of_a_quantile_stays_within_the_stated_1_6_over_k_for_95_percent_of_queries_at_several_quantiles():
    sized = size_kll(error=0.05)
    errors = []
    for t in range(TRIALS):
        rand = seeded_random(16000 + t)
        values = [random_u32(rand) for _ in range(3000)]
        sketch = KllSketch(sized["k"])
        for value in values:
            sketch.add(value)
        ordered = sorted(values)
        for q in (0.1, 0.5, 0.9, 0.99):
            v = sketch.quantile(q)
            below = sum(1 for x in ordered if x <= v) / len(ordered)
            strictly = sum(1 for x in ordered if x < v) / len(ordered)
            errors.append(max(0, q - below, strictly - q))
    errors.sort()
    p95 = errors[int(len(errors) * 0.95)]
    assert p95 <= sized["rankError"], (p95, sized["rankError"])
    assert p95 > sized["rankError"] * 0.2, p95
