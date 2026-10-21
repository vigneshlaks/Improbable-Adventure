# improbable adventure

A turn-based roguelike about probabilistic data structures. Enemies send streams of values at you; you deploy Bloom filters, Count-Min sketches, HyperLogLog and other structures to watch the stream, then act on their uncertain answers. A structure that guesses well wins the fight. One that guesses badly costs you Certainty, your health. Fuse structures into stronger ones, survive the act, and at the end export a working toolkit of the structures you used.

The structures are real implementations, not simulations, so what you learn about their error bounds and trade-offs carries over.

## Play

You need Node 22.18 or later and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev
```

This serves the game; open the address it prints. The page opens on a picture screen played with the keyboard (press `?` for the keys, `O` for the run overview). Press `T` to switch to the text screen, where every command works. Add `?seed=<text>` to the address to replay a particular run.

To play in the terminal instead:

```bash
pnpm cli --run
```

## How a fight works

1. **Deploy** structures into slots, giving each some of your limited Space.
2. **Ready**: the stream arrives, and the structures hear it. A structure only learns what streams while it is deployed.
3. **Strike**: the enemy asks a question (is this value in the stream? how many times did it appear? how many different values are there? what sits at this rank? which of these sets look alike?). Your structures answer with an estimate and a range. Strike with what you trust. A bad guess blocks your blow and costs you Certainty.
4. Win the fight, take a reward, fuse structures at rest stops, and face the elite and the boss.

Each enemy has traits (variety, skew, churn, growth, drift, likeness, cunning) that decide which structures work against it. Structures that cannot delete, for example, struggle against a stream that retracts values.

## The structures

Exact Memory, Reservoir Sampling, Bloom Filter, Count-Min Sketch, LogLog, Linear Counting, HyperLogLog, Count Sketch, Top-K Tracker, Cuckoo Filter, K-Minimum Values, KLL Sketch, t-digest, MinHash, Scalable Bloom Filter, Spectral Bloom Filter, Dyadic Count-Min, Quotient Filter, SimHash, Locality-Sensitive Hashing, HyperMinHash and the Theta Sketch.

## The toolkit export

When a run ends, **Export toolkit** builds a zip of working TypeScript or Python code for every structure you used. It is sized for a real workload you describe (item count, distinct count, acceptable error, memory budget), and comes with a decision guide and a field report written from your run. Each toolkit carries its own tests, which pass in both languages.

## Development

```bash
pnpm test            # unit and statistical tests
pnpm lint            # eslint and type checks
pnpm sim runs --bot greedy --n 200 --seed-base 100000   # balance reports with the bots
pnpm export check    # generate both toolkits and run their tests (needs Python 3.9+ and pytest)
```

The engine is deterministic: all randomness comes from a seeded generator, so a run replays exactly from its seed and actions. Every finished run can be saved as a replay and checked with `pnpm sim replay verify <file>`.

```
packages/
  engine/        pure game logic: hashing, structures, combat, runs, replays
  content/       the game's data: structures, enchantments, balance, narration
  ui-core/       command parser, narrator, sessions and the key menus
  cli/           the terminal game
  web/           the browser game
  sim/           bots and balance reports
  exporter/      toolkit generation, sizing and the templates
  env-server/    a JSON-lines server for the learning agent
rl/              Python: a Gymnasium environment and MaskablePPO training
```

[SPEC.md](SPEC.md) is the full design and records every decision. The engine imports nothing from the other packages, and each structure comes with unit tests and a statistical test of its error bound.

### The learning agent

A reinforcement-learning agent (Stable-Baselines3 MaskablePPO) can play the whole game through `packages/env-server`. See `rl/` and the "RL bridge" section of SPEC.md. To train one:

```bash
python -m venv rl/.venv && rl/.venv/bin/pip install -r rl/requirements.txt
cd rl && .venv/bin/python -m pda_env.train --steps 4000000 --envs 16
```

Trained on the final game, it wins about three quarters of held-out runs, against roughly 28 percent for the simple Greedy bot.

## License

Apache License 2.0. See [LICENSE](LICENSE).
