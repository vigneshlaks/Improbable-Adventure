import random

import pytest

from pda_env import EnvError, EnvServer


def first_legal(masks):
    return [m.index(True) if True in m else 0 for m in masks]


def test_the_server_describes_the_problem_plays_batches_and_repeats_a_finished_game():
    with EnvServer() as server:
        info = server.info()
        assert info["nActions"] == len(info["labels"]) > 100
        first = server.reset(["a1", "a2"])
        assert len(first.obs) == 2 and len(first.obs[0]) == info["obsSize"]
        assert len(first.masks[0]) == info["nActions"]
        assert all(0.0 <= x <= 1.0 for x in first.obs[0])
        assert first.dones == [False, False]

        # The same seeds give the same games.
        assert server.reset(["a1", "a2"]).obs == first.obs

        # Random legal play until both games have ended: wins and losses are reported, and ended games stay put.
        rng = random.Random(1)
        result = first
        for _ in range(3000):
            if all(d or t for d, t in zip(result.dones, result.truncated)):
                break
            result = server.step([rng.choice([i for i, ok in enumerate(m) if ok]) if any(m) else 0 for m in result.masks])
        assert all(d or t for d, t in zip(result.dones, result.truncated))
        again = server.step([0, 0])
        assert again.obs == result.obs and again.rewards == [0.0, 0.0]
        for done, won, turns in zip(result.dones, result.won, result.turns):
            if done:
                assert turns > 0
            else:
                assert not won

        # Restarting one game leaves the other alone.
        restarted = server.reset(["b1"], indices=[0])
        assert len(restarted.obs) == 1
        assert server.step([0, 0]).dones[1] == result.dones[1]


def test_the_server_answers_a_bad_request_with_an_error_and_keeps_going():
    with EnvServer() as server:
        server.reset(["x"])
        with pytest.raises(EnvError):
            server.step([10**6])
        with pytest.raises(EnvError):
            server.step([0, 0])  # one game, two actions
        assert len(server.reset(["y"]).obs) == 1
