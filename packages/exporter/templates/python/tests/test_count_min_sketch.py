import math

from sizing import size_count_min
from src.count_min_sketch import CountMinSketch
from .helpers import TRIALS, random_u32, seeded_random, stream, vectors


def test_a_count_min_sketch_matches_the_reference_answers_counts_exactly_when_alone_and_takes_counts_back():
    v = vectors["countMin"]
    sketch = CountMinSketch(v["width"], v["depth"])
    for i in range(v["events"]):
        sketch.add(stream(i % v["distinct"]))
    assert [sketch.estimate(stream(i)) for i in range(10)] == v["estimates"]

    alone = CountMinSketch(1024, 4)
    alone.add("apple", 5)
    assert alone.estimate("apple") == 5
    alone.remove("apple", 2)
    assert alone.estimate("apple") == 3
    alone.remove("apple", 10)  # counters stop at zero
    assert alone.estimate("apple") == 0


def test_statistical_never_underestimates_and_overshoots_the_band_no_more_often_than_e_to_the_minus_depth():
    sized = size_count_min(items=3000, error=0.02)
    under = over = total = 0
    for t in range(TRIALS):
        rand = seeded_random(2000 + t)
        values = [random_u32(rand) for _ in range(200)]
        truth = {}
        sketch = CountMinSketch(sized["width"], sized["depth"])
        for _ in range(3000):
            value = values[int(200 * rand() ** 2)]  # a few heavy values
            sketch.add(value)
            truth[value] = truth.get(value, 0) + 1
        for value in values:
            diff = sketch.estimate(value) - truth.get(value, 0)
            under += diff < 0
            over += diff > sketch.overshoot
            total += 1
    assert under == 0
    assert over / total <= math.exp(-sized["depth"]), over / total
