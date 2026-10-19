import pytest

from sizing import size_top_k
from src.top_k_tracker import TopKTracker
from .helpers import coverage_floor, random_u32, seeded_random, stream, vectors


def test_a_top_k_tracker_matches_the_reference_answers_tracks_the_heaviest_items_with_tight_intervals_takes_counts_back_and_frees_the_place_of_an_item_that_is_gone():
    v = vectors["topK"]
    tracker = TopKTracker(v["width"], v["depth"], v["capacity"])

    def value(i):
        return stream(int(60 * (((i * 7919) % 1000) / 1000) ** 2))

    for i in range(3000):
        tracker.add(value(i))
    for i in range(200):
        tracker.remove(value(i * 3))
    assert [{"item": c["item"], "low": c["low"], "high": c["high"]} for c in tracker.heavy_hitters()[: len(v["candidates"])]] == v["candidates"]
    for e in v["estimates"]:
        assert tracker.estimate(e["item"]) == {"low": e["low"], "high": e["high"]}, e["item"]

    alone = TopKTracker(256, 3, 2)
    for _ in range(5):
        alone.add("apple")
    for _ in range(3):
        alone.add("pear")
    for _ in range(3):
        alone.add("plum")  # the list holds two: apple, pear; plum is answered by the sketch
    assert len(alone.heavy_hitters()) == 2
    assert alone.estimate("apple") == {"low": 5, "high": 5}
    for _ in range(5):
        alone.remove("apple")
    assert not any(c["item"] == "apple" for c in alone.heavy_hitters())  # nothing of it is left
    assert alone.estimate("apple")["high"] <= 1
    single = TopKTracker(256, 3, 1)
    single.add("first")
    single.add("second")  # as heavy as the one listed, not heavier: it does not take the place
    assert [c["item"] for c in single.heavy_hitters()] == ["first"]
    single.add("second")
    assert [c["item"] for c in single.heavy_hitters()] == ["second"]  # now it is heavier
    with pytest.raises(ValueError):
        TopKTracker(10, 3, 0)


def test_statistical_the_heaviest_items_are_on_the_list_and_the_interval_of_each_holds_its_true_count_for_the_stated_share_of_items():
    sized = size_top_k(error=0.05)
    heavy = found = inside = listed = 0
    for t in range(100):
        rand = seeded_random(19000 + t)
        values = [random_u32(rand) for _ in range(200)]
        truth = {}
        tracker = TopKTracker(sized["width"], sized["depth"], sized["capacity"])
        for _ in range(2000):
            item = values[int(200 * rand() ** 3)]  # a few heavy items
            tracker.add(item)
            truth[item] = truth.get(item, 0) + 1
        on_list = {c["item"] for c in tracker.heavy_hitters()}
        for item, count in truth.items():
            if count >= 0.1 * 2000:  # items with at least twice the error's share
                heavy += 1
                found += item in on_list
        for c in tracker.heavy_hitters():
            listed += 1
            real = truth.get(c["item"], 0)
            inside += c["low"] <= real <= c["high"]
    assert heavy > 50, heavy
    assert found == heavy  # every item with at least 10 percent of the stream is on the list
    assert inside / listed >= coverage_floor(sized["confidence"], listed), inside / listed
