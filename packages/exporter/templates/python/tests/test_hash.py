import pytest

from src.hash import hash32, hash_bytes, positions
from .helpers import vectors


def test_hashing_matches_the_reference_answers_for_integers_and_strings_and_seeds_change_the_result():
    for c in vectors["hash"]:
        assert hash32(c["item"], c["seed"]) == c["hash"], c
    assert hash32(42, 1) != hash32(42, 2)
    assert hash_bytes(b"hello", 0) == hash32("hello", 0)
    with pytest.raises(ValueError):
        hash32(-1)
    with pytest.raises(ValueError):
        hash32(1.5)


def test_positions_match_the_reference_answers():
    for c in vectors["positions"]:
        assert positions(c["item"], c["k"], c["modulus"], c["seed"]) == c["positions"]
