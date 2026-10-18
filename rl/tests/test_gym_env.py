import pytest

pytest.importorskip("gymnasium")
pytest.importorskip("stable_baselines3")

import numpy as np  # noqa: E402

from pda_env.evaluate import evaluate, held_out_seeds, random_policy  # noqa: E402
from pda_env.gym_env import PdaEnv, PdaVecEnv, training_seeds  # noqa: E402


def test_the_gymnasium_environment_follows_the_api_and_masks_actions():
    env = PdaEnv(seed_fn=training_seeds("t"))
    try:
        obs, info = env.reset()
        assert env.observation_space.contains(obs)
        rng = np.random.default_rng(0)
        for _ in range(300):
            mask = env.action_masks()
            assert mask.any()
            obs, reward, terminated, truncated, info = env.step(int(rng.choice(np.flatnonzero(mask))))
            assert env.observation_space.contains(obs)
            if terminated or truncated:
                assert "won" in info
                obs, info = env.reset()
        assert env.reset(options={"seed": "7"})[1]["seed"] == "7"
    finally:
        env.close()


def test_the_vector_environment_restarts_ended_games_and_serves_masks_and_the_evaluator_plays_a_batch():
    venv = PdaVecEnv(4, training_seeds("v"))
    try:
        obs = venv.reset()
        assert obs.shape == (4, venv.observation_space.shape[0])
        rng = np.random.default_rng(1)
        ended = 0
        for _ in range(1500):
            masks = np.asarray(venv.env_method("action_masks"))
            venv.step_async(np.array([rng.choice(np.flatnonzero(m)) for m in masks]))
            obs, rewards, dones, infos = venv.step_wait()
            for done, info in zip(dones, infos):
                if done:
                    ended += 1
                    assert "terminal_observation" in info and "won" in info
        assert ended > 0
    finally:
        venv.close()

    result = evaluate(random_policy(3), held_out_seeds(6))
    assert result.games == 6 and 0 <= result.wins <= 6
