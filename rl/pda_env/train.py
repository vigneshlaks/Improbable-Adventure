"""Trains MaskablePPO on random seeds and measures it on held-out ones.

    python -m pda_env.train --steps 2000000 --envs 16 --out models/ppo
    python -m pda_env.train --evaluate models/ppo --greedy greedy.json

Needs gymnasium, stable-baselines3 and sb3-contrib (see requirements.txt).
"""
import argparse
from typing import List

import numpy as np
from sb3_contrib import MaskablePPO

from .evaluate import evaluate, greedy_win_rate, held_out_seeds, random_policy
from .gym_env import PdaVecEnv, training_seeds


def model_policy(model: MaskablePPO):
    def choose(obs: np.ndarray, masks: np.ndarray) -> List[int]:
        actions, _ = model.predict(obs, action_masks=masks, deterministic=True)
        return [int(a) for a in actions]

    return choose


def report(model: MaskablePPO, games: int, greedy_path: str = "") -> None:
    seeds = held_out_seeds(games)
    agent = evaluate(model_policy(model), seeds)
    floor = evaluate(random_policy(), seeds)
    print("held-out seeds %s..%s (%d games)" % (seeds[0], seeds[-1], games))
    print("  agent   wins %3d  (%.1f%%)  mean turns when won %s" % (agent.wins, 100 * agent.win_rate, agent.mean_turns_when_won))
    print("  random  wins %3d  (%.1f%%)" % (floor.wins, 100 * floor.win_rate))
    if greedy_path:
        print("  greedy  win rate %.1f%% (from %s)" % (100 * greedy_win_rate(greedy_path), greedy_path))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=1_000_000)
    parser.add_argument("--envs", type=int, default=16)
    parser.add_argument("--out", default="models/ppo")
    parser.add_argument("--evaluate", help="a saved model to measure instead of training")
    parser.add_argument("--games", type=int, default=200, help="held-out games to play")
    parser.add_argument("--greedy", default="", help="the Greedy bot's report (json) on the same seeds, to compare against")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    if args.evaluate:
        report(MaskablePPO.load(args.evaluate), args.games, args.greedy)
        return
    env = PdaVecEnv(args.envs, training_seeds("train"))
    model = MaskablePPO("MlpPolicy", env, seed=args.seed, verbose=1, n_steps=256, batch_size=512, ent_coef=0.01)
    model.learn(total_timesteps=args.steps)
    model.save(args.out)
    env.close()
    report(model, args.games, args.greedy)


if __name__ == "__main__":
    main()
