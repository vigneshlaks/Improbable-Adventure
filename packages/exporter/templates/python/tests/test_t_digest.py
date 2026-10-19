import pytest

from sizing import size_t_digest
from src.t_digest import TDigest
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_t_digest_matches_the_reference_answers_keeps_its_extremes_exactly_holds_every_value_in_its_weights_and_merges():
    v = vectors["tDigest"]
    digest = TDigest(v["compression"])
    for i in range(v["items"]):
        digest.add(stream(i))
    # The reference rounds a quantile to a whole number; the centroid arithmetic uses sin and asin, which may differ in the last digit between machines.
    assert abs(len(digest.summary) - v["centroids"]) <= 1
    for q in v["quantiles"]:
        assert abs(digest.quantile(q["quantile"]) - q["value"]) <= 1 + 1e-6 * q["value"], q["quantile"]
    assert sum(weight for _, weight in digest.summary) == v["items"]
    values = [stream(i) for i in range(v["items"])]
    assert digest.quantile(0) == min(values)
    assert digest.quantile(1) == max(values)
    assert len(digest.summary) <= v["compression"]

    small = TDigest(v["compression"])  # fewer values than centroids: every value is its own centroid
    for i in range(1, 21):
        small.add(i * 10)
    assert small.quantile(0.5) == 105  # interpolated between the two middle values
    assert TDigest(v["compression"]).quantile(0.5) is None

    left, right = TDigest(v["compression"]), TDigest(v["compression"])
    for i in range(3000):
        (left if i % 2 == 0 else right).add(stream(i))
    both = left.merge(right)
    assert both.count == 3000
    assert sum(weight for _, weight in both.summary) == 3000
    assert left.count == 1500
    with pytest.raises(ValueError):
        left.merge(TDigest(v["compression"] + 1))
    with pytest.raises(ValueError):
        TDigest(4)
    with pytest.raises(ValueError):
        small.add(float("inf"))
    assert TDigest(100).rank_error(0.5) == 0.02


def test_statistical_the_rank_error_at_a_quantile_stays_within_the_stated_4_sqrt_q_1_minus_q_over_compression_for_95_percent_of_streams_and_the_stated_error_is_smaller_in_the_tails():
    sized = size_t_digest(error=0.05)
    by_quantile = {0.01: [], 0.5: [], 0.99: []}
    for t in range(TRIALS):
        rand = seeded_random(17000 + t)
        values = [random_u32(rand) for _ in range(3000)]
        digest = TDigest(sized["compression"])
        for value in values:
            digest.add(value)
        ordered = sorted(values)
        for q in by_quantile:
            v = digest.quantile(q)
            below = sum(1 for x in ordered if x <= v) / len(ordered)
            strictly = sum(1 for x in ordered if x < v) / len(ordered)
            by_quantile[q].append(max(0, q - below, strictly - q))

    def stated(q):
        return TDigest(sized["compression"]).rank_error(q)

    for q, errors in by_quantile.items():
        errors.sort()
        assert errors[int(TRIALS * 0.95)] <= stated(q), (q, errors[int(TRIALS * 0.95)], stated(q))
    assert stated(0.01) < stated(0.5) / 4 and stated(0.99) < stated(0.5) / 4
    assert sized["rankError"] >= stated(0.5) - 1e-12
