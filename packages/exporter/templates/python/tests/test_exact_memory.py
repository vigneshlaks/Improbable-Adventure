from src.exact_memory import ExactMemory


def test_exact_memory_counts_every_item_exactly_takes_counts_back_and_never_goes_below_zero():
    table = ExactMemory()
    table.add("a", 3)
    table.add(7)
    table.add("a")
    assert table.count("a") == 4
    assert table.count(7) == 1
    assert table.count("never") == 0
    assert table.distinct == 2
    assert table.total == 5
    table.remove("a", 3)
    assert table.count("a") == 1
    table.remove("a", 10)
    assert table.count("a") == 0
    assert table.distinct == 1
    assert table.total == 1
