# Probabilistic Data Structure Roguelike — Build Spec

Oct 1, 2026 · @Someone

## Overview

A turn-based, text-first roguelike where players defeat enemies by deploying probabilistic data structures, acting on their uncertain answers, and fusing them into advanced structures. A run ends by exporting a working toolkit of every structure the player built.

**Guiding principle.** Everything is generic except the structures and their fusions. Enemies are stat blocks, upgrades are stat boosts, enchantments are generic modifiers. All specificity, and all teaching, lives in the structures, whose behavior in combat must match their real mathematical behavior.

**Goals**

- Every hit, miss, and overshoot follows the structure's real error behavior, computed from the parameters the player chose.
- Space versus error is the central tradeoff, as it is in real systems.
- Deterministic, seeded engine so runs replay exactly, support speedruns, and can be driven by bots and RL agents.
- The exported toolkit runs, passes its tests, and includes a sizing calculator and decision guide.

**Non-goals for v1**

- Real-time action, multiplayer, or graphics beyond small optional visualizations.
- Exact deterministic structures (sorting, search trees). Only Exact Memory exists, as a baseline.
- Persistent accounts. Leaderboards can come later.

## Tech stack and repository layout

TypeScript everywhere except RL training, which is Python talking to the TypeScript engine over a bridge.

| Concern | Choice |
| --- | --- |
| Language | TypeScript, strict mode |
| Monorepo | pnpm workspaces |
| Tests | Vitest |
| Web build | Vite |
| Content files | JSON, validated with Zod schemas |
| Hashing | MurmurHash3 x86 32-bit, implemented in-repo, seedable |
| Multiple hashes | Enhanced double hashing (Dillinger–Manolios): h\_i = h1 + i × h2 + (i³ − i) / 6. Plain Kirsch–Mitzenmacher (h\_i = h1 + i × h2) inflated Bloom false positives by 10% to 290% at small m or large k, so it was replaced (decided 2026-10-09). Count-Min Sketch rows are the exception: each row uses its own seeded Murmur hash, because additive double hashing leaves rows correlated (all d rows collide together with probability about 1 / w² instead of 1 / w^d), which weakens the e^-d guarantee and makes Cunning attacks too cheap (decided 2026-10-09) |
| Random numbers | Seeded PRNG implemented in-repo (e.g. sfc32 or xoshiro128\*\*); never Math.random |
| RL training | Python, Gymnasium, Stable-Baselines3 |

```
repo/
  CLAUDE.md                # conventions for Claude Code
  SPEC.md                  # this document, exported as Markdown
  packages/
    engine/                # pure game logic, no I/O, no UI
      src/hash/            # murmur3, double hashing
      src/rng/             # seeded PRNG
      src/structures/      # one file per structure + tests
      src/combat/          # turn loop, challenges, damage
      src/enemies/         # stream generation from traits
      src/run/             # run map, rewards, fusions
      src/replay/          # replay record + verify
    content/               # JSON: structures, fusions, enchantments, balance
    sim/                   # Node CLI: bots, batch runs, balance reports
    env-server/            # Node JSON-lines server for RL
    exporter/              # toolkit generation + templates per language
    web/                   # browser text-adventure UI
    cli/                   # terminal playable version (fast dev loop)
  rl/                      # Python: Gymnasium wrapper, training scripts
```

The engine package must not import from any other package. Every other package depends on the engine.

## Core rules

The player fights a stream they cannot fully remember, using structures sized from a fixed Space budget, and loses Certainty whenever they act on a wrong answer.

**Units.** Space is measured in bits. Any structure that stores raw values (Exact Memory, Reservoir Sampling, K-Minimum Values) pays VALUE\_BITS = 32 per stored value. All other structures pay for their actual bit or counter footprint.

**Resources**

| Resource | Scope | Starting value | Notes |
| --- | --- | --- | --- |
| Space | Per fight, resets each fight | 8,192 bits | Split across deployed structures |
| Certainty | Whole run, like HP | 100 | Lost on wrong strikes and enemy attacks; partially restored between fights |

**Enemies.** Every enemy is a stat block:

- **Size**: total values the stream will emit over the fight.
- **Integrity**: the enemy's HP, set by tier.
- **Tier**: Minion, Elite, or Boss. Scales Size, Integrity, attack, and trait count.
- **Traits**, each Low, Medium, or High: Variety, Skew, Churn, Growth, Likeness, Drift, Cunning.
- **Weak point**: one of Presence, Frequency, Count, Likeness, Rank. Hidden until its first challenge. Elites and Bosses may have two.
- **Turn limit**: if the fight reaches it, the enemy overflows and the player loses the fight.

Traits are always visible as Low, Medium, or High and generate flavor text. Certain trait mixes hint at the weak point (for example, High Skew hints Frequency), configured in content.

**Turn loop**

1. **Deploy.** Place, resize, or remove structures. Removing a structure refunds its Space and discards what it learned. A newly placed structure has seen nothing that streamed before it.
2. **Ingest.** The enemy emits a burst of stream events. Every deployed structure processes each event. The player sees only what structures report, except Reservoir Sampling and Exact Memory, which show raw values.
3. **Challenge.** From turn 2 onward, the enemy presents one challenge of its weak-point kind.
4. **Query.** Free. Each relevant structure returns an answer plus its error bound.
5. **Strike.** The player commits one action, resolved by the damage rules.
6. **Enemy attack.** The enemy deals its tier's Certainty damage.

**Outcomes.** Integrity at 0 wins the fight. Certainty at 0 ends the run. Reaching the turn limit loses the fight and costs a large Certainty penalty.

## Challenges and damage

Every challenge has a true answer computed by the engine from the live stream, and damage depends on how close the player's committed action is to it. Answers are always shown with their error bound, so the decision at strike time is how much to trust them. All capitalized constants live in `content/balance.json`.

| Weak point | Challenge | Player commits | Resolution |
| --- | --- | --- | --- |
| Presence | T targets (default 12), roughly half real, the rest decoys. Deleted values count as decoys. | A subset of targets | Each real target hit deals HIT\_DAMAGE. Each decoy hit costs DECOY\_PENALTY Certainty. |
| Frequency | The enemy's most frequent live value, shielded by its true count f | A force s | s below f is blocked and costs BLOCK\_PENALTY. Otherwise damage follows formula 1. |
| Count | The number of distinct live values D | An estimate E | Damage follows formula 2. Accuracy below zero costs MISS\_PENALTY. |
| Likeness | K copies (default 6), each a set of values. A copy is real if its Jaccard similarity to the live stream set is at least LIKE\_THRESHOLD (default 0.6). | A subset of copies | Same as Presence. |
| Rank | Armor at quantile q of live values (q per enemy, e.g. 0.5, 0.9, 0.99) | A value s | If s ranks below q, blocked. Otherwise damage follows formula 3. |

Formula 1, Frequency (overshoot wastes force):

```latex
\text{damage} = \text{BASE} \times \left(\frac{f}{s}\right)^{\text{OVERSHOOT\_EXP}}, \quad s \ge f
```

Formula 2, Count (closeness within a tolerance band):

```latex
\text{damage} = \text{BASE} \times \max\left(0,\ 1 - \frac{|E - D|}{\text{COUNT\_TOL} \times D}\right)
```

Formula 3, Rank (measured in rank, not raw value, so value scale never matters):

```latex
\text{damage} = \text{BASE} \times \max\left(0,\ 1 - \frac{\text{rank}(s) - q}{\text{RANK\_TOL}}\right), \quad \text{rank}(s) \ge q
```

**Frequency challenge shape (decided 2026-10-10).** The challenge names the shielded value: the enemy's most frequent live value `v` is shown to the player, and `query` asks every capable structure about `v`. The player never sees the true count `f`. The engine recomputes `v` and `f` each turn from exact live counts (deletes lower counts, Drift can change the top value); ties go to the lowest value. `strikeValue` carries only the force `s`.

**Risk choices the UI must support.** Targets flagged by two structures are marked as confirmed, so the player can strike only confirmed targets. For Frequency and Rank, the UI offers the structure's estimate, its upper bound, and a free number, so the player chooses between safe and greedy strikes.

Starting values: BASE 20, HIT\_DAMAGE 5, DECOY\_PENALTY 4, BLOCK\_PENALTY 3, MISS\_PENALTY 3, OVERSHOOT\_EXP 2, COUNT\_TOL 0.25, RANK\_TOL 0.1. All are placeholders until the simulator tunes them.

## Structures

Fourteen structures ship in three phases. The MVP covers Presence, Frequency, and Count with six structures plus the HyperLogLog fusion. Skip List is cut: it stores every value, so it is just Exact Memory with ordering.

The player chooses the Space for each structure and at most one extra knob. The engine derives the remaining parameters optimally, so player decisions stay readable.

| Structure | Phase | Answers | Player knobs | Space cost (bits) | Error behavior | Handles deletes |
| --- | --- | --- | --- | --- | --- | --- |
| Exact Memory | MVP | All | Space | 64 per distinct value (value + counter) | Exact; refuses new values when full | Yes |
| Reservoir Sampling | MVP | Any, roughly; shows raw values | Space | 32 per slot | Uniform sample; estimates scale by sample fraction | No (sample keeps ghosts) |
| Bloom Filter | MVP | Presence | Space, expected items n | m | False positives (1 − e^(−kn/m))^k with k = round((m/n) ln 2); no false negatives | No |
| Count-Min Sketch | MVP | Frequency | Space, depth d | 32 × w × d | Never underestimates; overestimate at most (e/w) × N with probability 1 − e^(−d) | Yes, if counts stay non-negative |
| LogLog | MVP | Count | Space | 5 × m registers | Standard error about 1.30 / √m | No |
| Linear Counting | MVP | Count | Space | m | Estimate −m ln(V), V = fraction of zero bits; fails as V approaches 0 | No |
| Cuckoo Filter | 2 | Presence | Space, fingerprint bits f | buckets × 4 × f | False positives about 8 / 2^f; inserts fail above about 95% load, after which false negatives appear | Yes |
| Count Sketch | 2 | Frequency | Space, depth d | 32 × w × d | Unbiased, error scales with the stream's L2 norm over √w | Yes |
| K-Minimum Values | 2 | Count, set math | Space | 32 × k | Relative error about 1 / √(k − 2) | No |
| MinHash | 2 | Likeness | Space | 32 × k | Jaccard standard error at most 1 / (2√k) | No |
| t-digest | 2 | Rank | Space (sets compression) | 64 per centroid | Most accurate at extreme quantiles; calibrate empirically | No |
| KLL Sketch | 2 | Rank | Space (sets k) | 32 per stored item | Uniform rank error shrinking with k; calibrate empirically | No |
| Quotient Filter | 3 | Presence | Space, remainder bits r | 2^q × (r + 3) | False positives about 2^(−r); mergeable | Yes |
| SimHash | 3 | Likeness | Space | 64 per fingerprint | Rough cosine similarity; weak on exact duplicates | No |

**Rules every implementation must follow**

- Structures that do not support deletes ignore delete events. That is the intended weakness against Churn, not a bug.
- Every query returns an estimate plus a low and high bound at a configured confidence (default 95%). For structures with one-sided error, one bound equals the estimate.
- Each structure gets a statistical test in the engine: over many seeded trials, its observed error must fall within its theoretical bound. Where no clean bound exists (t-digest, KLL), the test records an empirical table that the query uses for its bounds.

## Enchantments, upgrades, and fusions

Upgrades change only game numbers, never structure math. Enchantments and fusions change structure behavior, but only into real variants with real error behavior.

**Upgrades** (generic, run-wide)

| Upgrade | Effect |
| --- | --- |
| Capacity | +1,024 bits of Space per fight |
| Slots | +1 deploy slot (default 3) |
| Resolve | +20 maximum Certainty |
| Recovery | +10 Certainty restored after each fight |
| Power | +10% damage on all strikes |

The earlier "Precision" and "Compactness" upgrades are removed. They would make structures beat their real error bounds, which breaks the teaching and the exported sizing guide.

**Enchantments** (generic, attached to one structure slot)

| Enchantment | Effect | Valid on |
| --- | --- | --- |
| Seeded | Random hash seed per fight; Cunning collisions stop working | Any hashed structure |
| Merge | Combines two same-shaped instances, e.g. one per enemy in a multi-enemy fight | Mergeable structures: Bloom, Count-Min, LogLog, HyperLogLog, KMV, MinHash, t-digest, KLL, Quotient |
| Fading | Old information decays at a set rate; counters Drift | Bloom, Count-Min |
| Steady | Reduces overestimate or variance at +10% Space | Count-Min, LogLog |
| Light | Narrower counters or registers: −25% Space, higher error and saturation risk | Count-Min, LogLog, HyperLogLog |

**Transforms.** Some enchantments turn a specific structure into its named real variant:

- Bloom Filter + Fading → Stable Bloom Filter
- Count-Min Sketch + Steady → Count-Min with Conservative Update (note: loses delete support)
- LogLog + Steady → SuperLogLog

**Fusions.** Owning both inputs unlocks a fusion at a rest stop. Fusing consumes the inputs, and the result takes one slot.

| Inputs | Result | Phase | Effect |
| --- | --- | --- | --- |
| LogLog + Linear Counting | HyperLogLog | MVP | Count with standard error about 1.04 / √m, using linear counting for small ranges |
| Bloom Filter + Bloom Filter | Scalable Bloom Filter | 2 | Adds tighter layers as it fills; immune to Growth, draws Space from a reserve |
| Bloom Filter + Count-Min Sketch | Spectral Bloom Filter | 2 | Presence and Frequency from one slot |
| Count-Min Sketch + Exact Memory | Top-K Tracker | 2 | Count-Min ranks a small exact candidate list; strong vs High Skew |
| Count-Min Sketch + Count-Min Sketch | Dyadic Count-Min | 2 | Answers Rank over a bounded integer universe |
| KMV + KMV | Theta Sketch | 2 | Count unions and intersections across enemies |
| MinHash + MinHash | Locality-Sensitive Hashing | 2 | Flags all real copies in a Likeness challenge at once |
| HyperLogLog + MinHash | HyperMinHash | 3 | Likeness at HyperLogLog's Space cost |

The HyperLogLog recipe is a teaching shortcut: historically its main change from LogLog is harmonic-mean averaging, with linear counting only correcting small counts. The in-game description should say so.

## Enemy stream generation

An enemy is a seeded generator of stream events, `{ op: "insert" | "delete", value: uint32 }`, shaped by its traits. Values are drawn by rank from a Zipf distribution, then mapped to concrete values through a seeded permutation.

| Trait | Low | Medium | High | Implementation |
| --- | --- | --- | --- | --- |
| Variety | 2^8 values | 2^14 values | 2^22 values | Size of the value universe |
| Skew | Zipf s = 0 (uniform) | s = 0.8 | s = 1.2 | Zipf exponent over ranks |
| Churn | 0% deletes | 10% | 30% | Share of events that delete a currently live value |
| Growth | ×1.0 per turn | ×1.15 | ×1.35 | Burst size multiplier compounding each turn |
| Drift | None | 25% of top ranks remapped every 4 turns | 50% every 3 turns | Partial reshuffle of the rank-to-value permutation |
| Likeness | Decoy copies far below threshold | Near threshold | Just below threshold | How hard Likeness challenges are |
| Cunning | 0% adversarial | 5% | 15% | Share of events crafted against unseeded structures |

Burst size on turn t is (Size / EXPECTED\_TURNS) × growth^t, so Growth enemies outrun what the player sized for.

**Challenge generation.** Presence decoys are values never inserted, plus deleted values (ghosts). Likeness copies are generated as mutated subsets of the live set, with real copies above LIKE\_THRESHOLD and decoys placed per the Likeness trait.

**Cunning, implemented literally.** Unseeded structures hash with a fixed public seed, so the enemy can attack them for real, within a search budget of CUNNING\_SEARCH (default 50,000 candidates per turn):

- Against Bloom-style filters, it searches for values the player's current filter wrongly reports as present and uses them as Presence decoys.
- Against Count-Min, it inserts values that collide with its core value's counters, inflating the overestimate.
- Against LogLog and HyperLogLog, it inserts values whose hashes have many leading zeros, inflating Count estimates.

A Seeded structure uses a per-fight secret seed. The enemy keeps attacking with the public seed, which then has no special effect. The engine must not peek at the secret seed when generating adversarial values.

## Run structure and rewards

The MVP run is one act: five fights, one rest stop, one Elite, then a Boss. The full game has three acts.

- **Starting loadout:** Exact Memory, Reservoir Sampling, Bloom Filter; 3 slots; 8,192 bits; 100 Certainty.
- **After each fight:** pick 1 of 3 rewards, drawn from new structures, upgrades, and enchantments. Weights live in `content/balance.json`.
- **Rest stop:** perform fusions, move enchantments between structures, and restore REST\_HEAL Certainty (default 30).
- **Enemy pacing:** trait count and levels rise through the act. Minions have 1–2 non-Low traits, Elites 3, the Boss 4 plus two weak points.
- **End of run:** win or lose, the player can export the toolkit built so far.

## Engine API and data

The engine is a pure state machine: `step(state, action)` returns a new state plus events, and the same seed and actions always produce the same result.

```typescript
// Core engine surface (packages/engine/src/index.ts)
export function createRun(seed: string, config: RunConfig): RunState;
export function legalActions(state: RunState): Action[];
export function step(state: RunState, action: Action): StepResult;
export function observe(state: RunState): Observation; // what the player may see

export interface StepResult {
  state: RunState;
  events: GameEvent[];   // narrated by UIs, logged in replays
  reward: number;        // used by RL; ignored by UIs
  done: boolean;
}

export interface Structure {
  readonly kind: StructureKind;
  readonly params: Record<string, number>;
  spaceBits(): number;
  ingest(event: StreamEvent): void;
  query(challenge: Challenge): Answer | null; // null = cannot answer this kind
  clone(): Structure;
  merge?(other: Structure): Structure;
}

export interface Answer {
  estimate: number | number[]; // number[] for subset answers (flagged targets)
  low: number;
  high: number;
  confidence: number;          // default 0.95
}

export type Action =
  | { type: "deploy"; slot: number; kind: StructureKind; spaceBits: number; knob?: number }
  | { type: "remove"; slot: number }
  | { type: "endDeploy" }
  | { type: "strikeSubset"; targets: number[] }
  | { type: "strikeValue"; value: number }
  | { type: "chooseReward"; index: number }
  | { type: "fuse"; recipeId: string }
  | { type: "enchant"; slot: number; enchantmentId: string };
```

**Determinism rules**

- All randomness flows from one seeded PRNG in the run state, split into named sub-streams (enemy, rewards, hash seeds) so adding a feature never shifts other streams.
- No `Math.random`, `Date.now`, or iteration over unordered collections without sorting.
- RunState must be serializable to JSON and round-trip exactly.
- Structures copy on write so `step` never mutates its input state.

**Content files** in `packages/content`, each validated by a Zod schema at load:

| File | Holds |
| --- | --- |
| structures.json | Name, phase, answerable weak points, knobs with ranges, flavor text |
| fusions.json | Recipe id, inputs, result, phase |
| enchantments.json | Id, effect parameters, valid structure kinds, transforms |
| upgrades.json | Id, stat changes |
| traits.json | Level tables from the stream generation section, weak-point hint weights |
| balance.json | Every capitalized constant in this spec |

## Replays and speedruns

A replay is just the engine version, seed, config, and action list, so runs are tiny to store and verified by re-simulating them.

```typescript
interface Replay {
  engineVersion: string;   // bump on any rule change; old replays verify against old versions
  contentHash: string;     // hash of all content JSON
  seed: string;
  config: RunConfig;
  actions: Action[];
  claimed: { won: boolean; turns: number; certaintyLeft: number };
}
```

- `verifyReplay(replay)` re-runs every action, rejects any illegal action, and checks the claimed result.
- **Speedrun metric:** total turns to finish the run, ties broken by Certainty left.
- **Categories:** Fixed Seed (everyone plays the same published seed) and Random Seed (fresh seed per attempt, best of many).
- Replays double as imitation-learning data for the RL agent and as regression tests: a folder of recorded replays must still verify after every change unless the engine version is bumped.

## Simulation and balance

Balance is tuned by running thousands of seeded fights with scripted bots before any RL work. The `sim` package is a Node CLI.

**Bots**

| Bot | Strategy | Purpose |
| --- | --- | --- |
| Random | Uniform legal actions | Floor; catches crashes and illegal states |
| Greedy | Deploys the best-matching structure for visible traits, strikes on the estimate | Baseline competent play |
| Prober | Opens with Reservoir Sampling, then commits | Detects whether probing is a dominant strategy |
| Cautious | Strikes only confirmed targets and safe bounds | Tests whether safe play is viable |
| Oracle | Knows the true answers | Ceiling; shows the maximum achievable speed |

**Commands**

```
pnpm sim fights --bot greedy --n 10000 --seed-base 1     # fight-level stats
pnpm sim runs --bot prober --n 2000                       # full-run stats
pnpm sim compare --bots greedy,prober,cautious --n 5000   # side by side
```

**Report metrics:** win rate, turns per fight, Certainty lost by cause, structure deploy and win rates, and observed error rate per structure versus theory.

**Balance targets** (initial, revisit after playtesting):

- Greedy wins 55–70% of MVP runs; Random wins under 5%; Oracle wins over 95%.
- No single opener is used in more than 40% of winning Greedy-family runs.
- Wrong-answer strikes occur on 10–30% of turns, so error is felt but not dominant.
- Each MVP structure appears in at least 15% of winning runs.

## RL bridge

Training runs in Python against the TypeScript engine, which runs as a Node process speaking JSON lines over stdin and stdout. Build this only after the bots show the game is balanced enough to be worth learning.

**Protocol** (`packages/env-server`), one JSON object per line, batched across N parallel games to cut overhead:

```
→ {"cmd":"reset","seeds":["a1","a2"]}
← {"obs":[[...],[...]],"masks":[[...],[...]]}
→ {"cmd":"step","actions":[14,3]}
← {"obs":[...],"masks":[...],"rewards":[0.2,-0.1],"dones":[false,false]}
```

**Observation:** a fixed-length float vector built by `observe()`: trait levels, Space used and free, Certainty, turn, slot contents and parameters, current challenge kind, and each structure's latest answer and bounds. Hidden true answers are never included.

**Actions:** one discrete index with an action mask of legal moves. Deploys are discretized to structure × slot × Space share (25%, 50%, 75%, or 100% of remaining). Strikes are discretized to options the UI already offers: all flagged, confirmed only, estimate, upper bound, lower bound.

**Reward (speedrun shaping):** +1 per enemy defeated, −0.01 per turn, −0.005 per Certainty lost, −1 on run loss. Weights live in a config file.

**Python side** (`rl/`): a Gymnasium environment wrapping the server, trained with MaskablePPO from sb3-contrib (the Stable-Baselines3 companion package). Train on random seeds, evaluate on a held-out seed set, and optionally pretrain by behavior cloning from verified human replays.

## Exporter

The export is a zip of working code for every structure and fusion the player owns, sized for a real workload the player enters, plus a decision guide written from their run. The code is a clean, tested reference layer; the sizing and guide are the unique value.

**Inputs at export time**

- Target language: TypeScript and Python in MVP; Go later.
- Real workload: expected item count, expected distinct count, acceptable error, and memory budget. Any field can be left blank.
- The player's **tradeoff profile**, computed from the run: how they balanced Space against error per structure, as a ratio relative to theoretical optimum.

Parameters are computed from the real workload and the tradeoff profile, never copied from in-game values. Game parameters are deliberately tight for tension and would be wrong in production.

**Zip contents**

```
toolkit/
  README.md          # what each structure answers, when to use it
  SIZING.md          # chosen parameters, resulting error, memory, formulas
  FIELD_REPORT.md    # from the run: wins by structure, traits handled, mistakes
  sizing.(ts|py)     # calculator: workload in, parameters out
  src/               # one file per structure, seedable hashing
  tests/             # unit tests + statistical error tests
```

**Templates** live in `packages/exporter/templates/<language>/`, one per structure. CI generates a toolkit containing every structure for every language and runs its tests with that language's real toolchain. A template change that breaks generated tests fails the build.

The browser bundles the exporter and builds the zip client-side (JSZip), so exporting needs no server.

## User interface

The CLI and web UI share one command parser and one narrator; both only translate between text and engine actions. The CLI comes first because it is the fastest development loop.

| Command | Example | Engine action |
| --- | --- | --- |
| deploy \<structure> \<bits> \[knob\] | deploy bloom 6000 600 | deploy |
| remove \<slot> | remove 2 | remove |
| ready | ready | endDeploy |
| query | query | none (shows answers) |
| strike \<targets> | strike 1 3 4 | strikeSubset |
| strike confirmed / flagged | strike confirmed | strikeSubset |
| strike \<value> / estimate / high / low | strike high | strikeValue |
| status | status | none |
| help \[topic\] | help bloom | none |

**Narration** is generated from engine events using templates in content, never by hand inside UI code. Enemy flavor text comes from its traits.

**Web extras:** a side panel with live visuals of each deployed structure (bit array fill, counter heatmap, register bars), an error-rate readout that updates as the stream grows, and a light/dark theme. Every visual is optional; the game must be fully playable as text.

## Milestones

Build in this order; each milestone must pass its acceptance criteria before the next starts. M3 is the go/no-go point for whether the game is fun.

| Milestone | Scope | Acceptance criteria |
| --- | --- | --- |
| M0 Scaffold | Monorepo, TypeScript strict, Vitest, lint, CI, CLAUDE.md | `pnpm test` and `pnpm lint` pass in CI on an empty engine |
| M1 Foundations | Murmur3, double hashing, seeded PRNG, the six MVP structures | Known-answer hash tests pass; each structure's statistical error test passes over 1,000 seeded trials |
| M2 Combat | Stream generator, traits, Presence/Frequency/Count challenges, damage, single-fight loop | A scripted fight replays identically from its seed; state round-trips through JSON |
| M3 Playable CLI + bots | CLI, narrator, Random/Greedy/Prober/Cautious/Oracle bots, sim reports | A human can play a full fight in the terminal; sim produces the full metrics report |
| M4 Run loop | Rewards, rest stop, HyperLogLog fusion, enchantments, upgrades, Elite and Boss | MVP balance targets met in sim, or deviations documented |
| M5 Replays | Replay recording, verification, speedrun metric | Recorded replays verify; a tampered replay is rejected |
| M6 Web UI | Browser text adventure, visual side panel | Full MVP run playable in the browser on desktop and mobile widths |
| M7 Exporter | TypeScript and Python templates, sizing calculator, reports, zip | CI-generated toolkits pass their own tests in both languages |
| M8 RL bridge | Env server, Gymnasium wrapper, MaskablePPO baseline | Trained agent beats Greedy on held-out seeds |
| M9 Phase 2 content | Remaining structures, fusions, Likeness and Rank challenges, Cunning | Each new structure passes its statistical test; balance re-tuned |

## Working with Claude Code

Export this doc as Markdown to `SPEC.md` at the repo root, add the `CLAUDE.md` below, and run one milestone per session.

**CLAUDE.md starter**

```markdown
# Project conventions

Read SPEC.md before any task. It is the source of truth; if code and spec disagree, stop and ask.

## Rules
- packages/engine is pure: no I/O, no Date.now, no Math.random. All randomness uses the run's seeded PRNG.
- Engine must never import from other packages.
- Every capitalized constant comes from packages/content/balance.json. No magic numbers.
- Each structure gets unit tests AND a statistical error test against its bound in SPEC.md.
- Never "fix" a statistical test by loosening its bound without asking.
- Run `pnpm test && pnpm lint` before declaring a task done.

## Commands
- pnpm test | pnpm lint | pnpm sim <cmd> | pnpm cli | pnpm dev (web)
```

**Prompt sequence** (one per session, in plan mode first, then implement):

1. "Read SPEC.md. Implement milestone M0 exactly as specified. Propose the plan before writing code."
2. "Implement M1. Start with hashing and the PRNG with known-answer tests, then one structure at a time, each with its statistical test."
3. "Implement M2. Write a seeded scripted fight test first, then make it pass."
4. Continue one milestone per session. After M3, paste the sim report back and ask Claude Code to suggest balance.json changes against the targets.

**Tips:** keep sessions to one milestone, ask for tests before implementation on M1 and M2, and update SPEC.md whenever a design decision changes so later sessions stay consistent.

## Open questions

- Game title. "Probabilistic Data Structure Roguelike" is a placeholder.
- Does Certainty carry across the whole run (current spec) or reset per act?
- Should Exact Memory stay in the starting loadout, or be a reward so early fights force sketch use?
- Weak point reveal: on the first challenge (current spec), or only through probing?
- Export languages after TypeScript and Python: Go, Rust, or Java?
- Leaderboard hosting for speedruns: static seeds published in-repo first, server later?
- All values in balance.json and the trait tables are starting guesses until M3 and M4 simulations tune them.
