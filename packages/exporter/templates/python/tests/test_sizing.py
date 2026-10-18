import re

import pytest

import sizing
from .helpers import vectors


def _snake(name: str) -> str:
    return re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), name)


def test_sizing_matches_the_reference_answers_for_every_structure():
    for c in vectors["sizing"]:
        function = getattr(sizing, _snake(c["fn"]))
        result = function(**{_snake(k): v for k, v in c["input"].items()})
        for key, expected in c["output"].items():
            if isinstance(expected, bool):
                assert result[key] == expected, (c["fn"], c["input"], key)
            else:
                assert abs(result[key] - expected) <= 1e-9 * max(1, abs(expected)), (c["fn"], c["input"], key)


def test_sizing_refuses_what_it_cannot_size():
    with pytest.raises(ValueError):
        sizing.size_bloom(error=0.01)
    with pytest.raises(ValueError):
        sizing.size_hyper_log_log(distinct=100, error=0)
    with pytest.raises(ValueError):
        sizing.size_hyper_log_log(distinct=100, error=1.5)
