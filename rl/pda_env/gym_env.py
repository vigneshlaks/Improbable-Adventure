"""Gymnasium and Stable-Baselines3 environments over the environment server.

Needs `gymnasium`, `numpy` and `stable-baselines3` (see requirements.txt).
"""
import itertools
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Type

import gymnasium as gym
import numpy as np
from gymnasium import spaces
from stable_baselines3.common.vec_env.base_vec_env import VecEnv

from .client import EnvServer, StepResult


def training_seeds(prefix: str = "train") -> Callable[[], str]:
    """An endless supply of distinct seeds. They are not numbers, so they never collide with the numeric seeds of the held-out set."""
    counter = itertools.count()
    return lambda: "%s-%d" % (prefix, next(counter))


def _arrays(result: StepResult) -> Tuple[np.ndarray, np.ndarray]:
    return np.asarray(result.obs, dtype=np.float32), np.asarray(result.masks, dtype=bool)


class PdaEnv(gym.Env):
    """One game as a Gymnasium environment. `action_masks()` gives the legal actions, as MaskablePPO expects."""

    metadata: Dict[str, Any] = {"render_modes": []}

    def __init__(self, server: Optional[EnvServer] = None, seed_fn: Optional[Callable[[], str]] = None) -> None:
        super().__init__()
        self._server = server or EnvServer()
        self._seed_fn = seed_fn or training_seeds()
        info = self._server.info()
        self.observation_space = spaces.Box(0.0, 1.0, shape=(info["obsSize"],), dtype=np.float32)
        self.action_space = spaces.Discrete(info["nActions"])
        self._mask = np.ones(info["nActions"], dtype=bool)

    def reset(self, *, seed: Optional[Any] = None, options: Optional[dict] = None) -> Tuple[np.ndarray, dict]:
        """Starts a game. `options={"seed": "..."}` (or a string `seed`) chooses which game; otherwise the next training seed."""
        super().reset(seed=seed if isinstance(seed, int) else None)
        chosen = (options or {}).get("seed") or (seed if isinstance(seed, str) else None) or self._seed_fn()
        obs, masks = _arrays(self._server.reset([chosen]))
        self._mask = masks[0]
        return obs[0], {"seed": chosen, "action_mask": self._mask}

    def step(self, action: int) -> Tuple[np.ndarray, float, bool, bool, dict]:
        result = self._server.step([int(action)])
        obs, masks = _arrays(result)
        self._mask = masks[0]
        info = {"won": result.won[0], "turns": result.turns[0], "action_mask": self._mask}
        return obs[0], float(result.rewards[0]), result.dones[0], result.truncated[0], info

    def action_masks(self) -> np.ndarray:
        return self._mask

    def close(self) -> None:
        self._server.close()


class PdaVecEnv(VecEnv):
    """N games played side by side, one message per step. A game that ends is restarted on the next training seed."""

    def __init__(self, n_envs: int, seed_fn: Optional[Callable[[], str]] = None, server: Optional[EnvServer] = None) -> None:
        self._server = server or EnvServer()
        info = self._server.info()
        super().__init__(
            n_envs,
            spaces.Box(0.0, 1.0, shape=(info["obsSize"],), dtype=np.float32),
            spaces.Discrete(info["nActions"]),
        )
        self._seed_fn = seed_fn or training_seeds()
        self._masks = np.ones((n_envs, info["nActions"]), dtype=bool)
        self._actions: Optional[np.ndarray] = None
        self._return = np.zeros(n_envs, dtype=np.float64)
        self._length = np.zeros(n_envs, dtype=np.int64)

    def reset(self) -> np.ndarray:
        self._return[:] = 0
        self._length[:] = 0
        obs, self._masks = _arrays(self._server.reset([self._seed_fn() for _ in range(self.num_envs)]))
        return obs

    def step_async(self, actions: np.ndarray) -> None:
        self._actions = np.asarray(actions)

    def step_wait(self):
        result = self._server.step([int(a) for a in self._actions])  # type: ignore[union-attr]
        obs, masks = _arrays(result)
        rewards = np.asarray(result.rewards, dtype=np.float32)
        ended = [d or t for d, t in zip(result.dones, result.truncated)]
        self._return += rewards
        self._length += 1
        infos: List[dict] = [{} for _ in range(self.num_envs)]
        for i, over in enumerate(ended):
            if over:
                infos[i] = {"episode": {"r": float(self._return[i]), "l": int(self._length[i])}, "won": result.won[i], "turns": result.turns[i], "TimeLimit.truncated": result.truncated[i] and not result.dones[i], "terminal_observation": obs[i].copy()}
        if any(ended):
            indices = [i for i, over in enumerate(ended) if over]
            fresh_obs, fresh_masks = _arrays(self._server.reset([self._seed_fn() for _ in indices], indices=indices))
            for row, i in enumerate(indices):
                obs[i] = fresh_obs[row]
                masks[i] = fresh_masks[row]
                self._return[i] = 0
                self._length[i] = 0
        self._masks = masks
        return obs, rewards, np.asarray(ended, dtype=bool), infos

    def close(self) -> None:
        self._server.close()

    def get_attr(self, attr_name: str, indices=None) -> List[Any]:
        # MaskablePPO asks whether the environment supports masking by reading this attribute.
        if attr_name != "action_masks":
            raise AttributeError(attr_name)
        chosen = range(self.num_envs) if indices is None else (indices if isinstance(indices, Sequence) else [indices])
        return [(lambda i=i: self._masks[i]) for i in chosen]

    def set_attr(self, attr_name: str, value: Any, indices=None) -> None:
        raise AttributeError(attr_name)

    def env_method(self, method_name: str, *method_args, indices=None, **method_kwargs) -> List[Any]:
        if method_name != "action_masks":
            raise AttributeError(method_name)
        chosen = range(self.num_envs) if indices is None else (indices if isinstance(indices, Sequence) else [indices])
        return [self._masks[i] for i in chosen]

    def env_is_wrapped(self, wrapper_class: Type[gym.Wrapper], indices=None) -> List[bool]:
        return [False] * self.num_envs
