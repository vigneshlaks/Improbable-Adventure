"""Plays held-out seeds with a policy and reports how often it wins.

The policy is any function from (observations, masks) to one action index per game. Games that end early wait (the server
repeats their last reply) while the others finish, so the whole set is played in one batch.
"""
import json
import os
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence

import numpy as np

from .client import EnvServer

Policy = Callable[[np.ndarray, np.ndarray], Sequence[int]]

#: The held-out set the sim bots are measured on too: `pnpm sim runs --seed-base 100000`.
HELD_OUT_BASE = 100000


def held_out_seeds(n: int, base: int = HELD_OUT_BASE) -> List[str]:
    return [str(base + i) for i in range(n)]


@dataclass
class Evaluation:
    games: int
    wins: int
    mean_turns_when_won: Optional[float]
    stalled: int

    @property
    def win_rate(self) -> float:
        return self.wins / self.games


def evaluate(policy: Policy, seeds: Sequence[str], server: Optional[EnvServer] = None, max_steps: int = 5000, replay_dir: Optional[str] = None) -> Evaluation:
    own = server is None
    server = server or EnvServer()
    try:
        result = server.reset(list(seeds))
        for _ in range(max_steps):
            if all(d or t for d, t in zip(result.dones, result.truncated)):
                break
            actions = policy(np.asarray(result.obs, dtype=np.float32), np.asarray(result.masks, dtype=bool))
            result = server.step(list(actions))
        if replay_dir:
            # Every game that ended is saved as a replay, so it can be re-played and checked by the game's own verifier.
            os.makedirs(replay_dir, exist_ok=True)
            for i, seed in enumerate(seeds):
                if result.dones[i]:
                    with open(os.path.join(replay_dir, "agent-%s-%s.json" % (seed, "won" if result.won[i] else "lost")), "w", encoding="utf-8") as handle:
                        json.dump(server.replay(i), handle)
        wins = [i for i, w in enumerate(result.won) if w]
        stalled = sum(1 for d in result.dones if not d)
        turns = [result.turns[i] for i in wins]
        return Evaluation(len(seeds), len(wins), float(np.mean(turns)) if turns else None, stalled)
    finally:
        if own:
            server.close()


def random_policy(seed: int = 0) -> Policy:
    """Any legal action with equal chance, the floor an agent must clear."""
    rng = np.random.default_rng(seed)

    def choose(obs: np.ndarray, masks: np.ndarray) -> List[int]:
        return [int(rng.choice(np.flatnonzero(m))) if m.any() else 0 for m in masks]

    return choose


def greedy_win_rate(path: str) -> float:
    """The Greedy bot's win rate from `pnpm sim runs --bot greedy --seed-base 100000 --n N --json > file`."""
    with open(path, encoding="utf-8") as handle:
        report = json.load(handle)["reports"][0]
    return float(report["winRate"])
