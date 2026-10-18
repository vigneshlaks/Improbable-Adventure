"""Trains MaskablePPO on random seeds and measures it on held-out ones.

    python -m pda_env.train --steps 2000000 --envs 16 --out models/ppo
    python -m pda_env.train --evaluate models/ppo --greedy greedy.json

Needs gymnasium, stable-baselines3 and sb3-contrib (see requirements.txt).
"""
import argparse
import os
from typing import List

import numpy as np
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import CheckpointCallback

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
    parser.add_argument("--resume", help="a checkpoint to continue training from")
    parser.add_argument("--checkpoint-every", type=int, default=250_000, help="steps between saved checkpoints (a crash then costs little)")
    parser.add_argument("--target-kl", type=float, default=0.02, help="stop a round of updates early when the policy has moved this far")
    args = parser.parse_args()

    if args.evaluate:
        report(MaskablePPO.load(args.evaluate), args.games, args.greedy)
        return
    env = PdaVecEnv(args.envs, training_seeds("train"))
    if args.resume:
        model = MaskablePPO.load(args.resume, env=env)
    else:
        # The learning rate falls from 3e-4 to a sixth of that over the run, and a round of updates stops early if the policy moves too far:
        # an earlier run with a fixed rate and no limit ended in NaN probabilities at about 2.1M steps.
        model = MaskablePPO(
            "MlpPolicy", env, seed=args.seed, verbose=1, n_steps=256, batch_size=512, ent_coef=0.01,
            learning_rate=lambda progress_left: 5e-5 + (3e-4 - 5e-5) * progress_left, target_kl=args.target_kl,
        )
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    checkpoints = CheckpointCallback(save_freq=max(1, args.checkpoint_every // args.envs), save_path=os.path.dirname(args.out) or ".", name_prefix=os.path.basename(args.out) + "-step")
    try:
        model.learn(total_timesteps=args.steps, callback=checkpoints, reset_num_timesteps=not args.resume)
    except ValueError as error:
        print("Training stopped on an error (the last checkpoint is kept): %s" % str(error).splitlines()[0])
        env.close()
        return
    model.save(args.out)
    env.close()
    report(model, args.games, args.greedy)


if __name__ == "__main__":
    main()
