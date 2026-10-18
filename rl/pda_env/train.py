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
import torch
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback

from .evaluate import evaluate, greedy_win_rate, held_out_seeds, random_policy
from .gym_env import PdaVecEnv, training_seeds


class SafePPO(MaskablePPO):
    """MaskablePPO that refuses to take an optimizer step with a gradient that is not finite.

    Earlier runs ended in NaN probabilities with healthy statistics up to the last update. The likely cause is a gradient norm that
    overflows: clipping then multiplies by zero and `inf x 0` is NaN, which spoils every weight at once. Here such a gradient is
    zeroed (and counted and reported) so the update is skipped instead.
    """

    skipped_steps = 0

    def _setup_model(self) -> None:
        super()._setup_model()
        self.policy.optimizer.register_step_pre_hook(self._skip_bad_gradients)

    def _skip_bad_gradients(self, optimizer, args, kwargs) -> None:
        bad = [name for name, p in self.policy.named_parameters() if p.grad is not None and not torch.isfinite(p.grad).all()]
        if not bad:
            return
        SafePPO.skipped_steps += 1
        if SafePPO.skipped_steps <= 5:
            print("skipping an optimizer step: the gradient is not finite for %s (step %d, %d timesteps)" % (bad[:4], SafePPO.skipped_steps, self.num_timesteps), flush=True)
        for p in self.policy.parameters():
            if p.grad is not None:
                p.grad.zero_()


class GuardCallback(BaseCallback):
    """After every rollout, checks that what the next update will learn from is sound, and says exactly what is not.

    A numerical error in training (NaN probabilities) can come from the data or from the weights; this tells which.
    """

    def _on_step(self) -> bool:
        return True

    def _on_rollout_end(self) -> None:
        for name, tensor in self.model.policy.state_dict().items():
            if not torch.isfinite(tensor).all():
                raise ValueError("the network weight %s is not finite" % name)
        buffer = self.model.rollout_buffer
        for field in ("observations", "rewards", "advantages", "returns", "values", "log_probs"):
            array = getattr(buffer, field)
            if not np.isfinite(array).all():
                raise ValueError("the rollout %s have %d values that are not finite" % (field, int((~np.isfinite(array)).sum())))
        empty = int((~buffer.action_masks.reshape(-1, buffer.action_masks.shape[-1]).any(axis=1)).sum())
        if empty:
            raise ValueError("the rollout has %d steps with no action allowed" % empty)
        spread = float(np.abs(buffer.advantages).max())
        if spread > 1e3:
            raise ValueError("the largest advantage is %g" % spread)


def explain(error: BaseException, model: MaskablePPO) -> None:
    """Looks in the stack of a failed rollout for what the policy was given, and says what is wrong with it."""
    tb = error.__traceback__
    found = {}
    while tb is not None:
        for name in ("obs_tensor", "action_masks", "obs"):
            if name in tb.tb_frame.f_locals:
                found[name] = tb.tb_frame.f_locals[name]
        tb = tb.tb_next
    obs = found.get("obs_tensor")
    masks = found.get("action_masks")
    weights_ok = all(bool(torch.isfinite(v).all()) for v in model.policy.state_dict().values())
    print("  weights finite: %s" % weights_ok)
    if obs is not None:
        array = obs.detach().cpu().numpy()
        print("  observation finite: %s (min %.3g, max %.3g)" % (bool(np.isfinite(array).all()), float(np.nanmin(array)), float(np.nanmax(array))))
    if masks is not None:
        rows = np.asarray(masks).reshape(len(masks), -1)
        print("  rows with no action allowed: %s" % np.flatnonzero(~rows.any(axis=1)).tolist())
        torch.distributions.Distribution.set_default_validate_args(False)
        with torch.no_grad():
            distribution = model.policy.get_distribution(obs, action_masks=np.asarray(masks))
            probs = distribution.distribution.probs
            sums = probs.sum(dim=-1)
            print("  probabilities: any NaN %s, row sums from %.9f to %.9f, largest single probability %.9f" % (bool(torch.isnan(probs).any()), float(sums.min()), float(sums.max()), float(probs.max())))
        np.savez("models/crash-inputs.npz", obs=obs.detach().cpu().numpy() if obs is not None else np.zeros(0), masks=rows)


def model_policy(model: MaskablePPO):
    def choose(obs: np.ndarray, masks: np.ndarray) -> List[int]:
        actions, _ = model.predict(obs, action_masks=masks, deterministic=True)
        return [int(a) for a in actions]

    return choose


def report(model: MaskablePPO, games: int, greedy_path: str = "", base: int = 100000, replay_dir: str = "") -> None:
    seeds = held_out_seeds(games, base)
    agent = evaluate(model_policy(model), seeds, replay_dir=replay_dir or None)
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
    parser.add_argument("--seed-base", type=int, default=100000, help="first held-out seed (the sim bots use the same seeds)")
    parser.add_argument("--save-replays", default="", help="a folder to save every evaluated game into, as replays the game can verify")
    parser.add_argument("--detect-anomaly", action="store_true", help="name the exact operation that first gives a NaN (slow)")
    parser.add_argument("--resume", help="a checkpoint to continue training from")
    parser.add_argument("--checkpoint-every", type=int, default=250_000, help="steps between saved checkpoints (a crash then costs little)")
    parser.add_argument("--target-kl", type=float, default=0.02, help="stop a round of updates early when the policy has moved this far")
    args = parser.parse_args()
    # PyTorch rejects a distribution whose probabilities do not sum to 1 within 1e-6. With over a hundred legal actions the float32 sum
    # is sometimes off by more than that, which ended earlier runs ("Expected parameter probs ... Simplex()") although nothing was
    # wrong: sampling and log-probabilities use the normalized logits. So the check is off.
    torch.distributions.Distribution.set_default_validate_args(False)

    if args.evaluate:
        report(MaskablePPO.load(args.evaluate), args.games, args.greedy, args.seed_base, args.save_replays)
        return
    env = PdaVecEnv(args.envs, training_seeds("train"))
    torch.autograd.set_detect_anomaly(args.detect_anomaly)
    if args.resume:
        model = SafePPO.load(args.resume, env=env)
    else:
        # The learning rate falls from 3e-4 to a sixth of that over the run, and a round of updates stops early if the policy moves too far:
        # an earlier run with a fixed rate and no limit ended in NaN probabilities at about 2.1M steps.
        model = SafePPO(
            "MlpPolicy", env, seed=args.seed, verbose=1, n_steps=256, batch_size=512, ent_coef=0.01,
            learning_rate=lambda progress_left: 5e-5 + (3e-4 - 5e-5) * progress_left, target_kl=args.target_kl,
        )
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    checkpoints = CheckpointCallback(save_freq=max(1, args.checkpoint_every // args.envs), save_path=os.path.dirname(args.out) or ".", name_prefix=os.path.basename(args.out) + "-step")
    try:
        model.learn(total_timesteps=args.steps, callback=[checkpoints, GuardCallback()], reset_num_timesteps=not args.resume)
    except ValueError as error:
        print("Training stopped on an error (the last checkpoint is kept): %s" % str(error).splitlines()[0])
        print("  full message: %s" % str(error).replace("\n", " ")[:1500])
        explain(error, model)
        env.close()
        return
    model.save(args.out)
    env.close()
    report(model, args.games, args.greedy)


if __name__ == "__main__":
    main()
