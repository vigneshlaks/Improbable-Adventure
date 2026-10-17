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
    ui-core/               # shared command parser and narrator (decided 2026-10-13)
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
| Certainty | Whole run, like HP | 150 (changed 2026-10-17) | Lost on wrong strikes and enemy attacks; partially restored between fights |

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

**Fight loop details (decided 2026-10-12).** The spec left these open:

- Space assigned to a structure is charged in full when it is deployed and refunded in full when it is removed. There is no resize action: resizing is a removal followed by a deploy. Only structures the player owns can be deployed.
- The enemy attacks at the end of every turn, including turn 1, which has no challenge.
- A challenge that cannot be issued (a Frequency challenge with nothing live) is skipped, and the turn ends without a strike.
- An enemy with several weak points uses them in order, one per turn, starting with its first on turn 2. A weak point is revealed when its first challenge is issued.
- A strike that takes Certainty to 0 ends the run even if it also defeats the enemy. Otherwise HP at 0 wins before the enemy attacks.
- The turn limit is checked after the enemy's attack: the fight is lost at the end of the turn equal to the limit, with the turn-limit penalty. If that penalty empties Certainty, the run is over.
- `legalActions` lists a finite representative set (deploys at 25, 50, 75 and 100 percent of the free Space, removals, strikes at each structure's estimate and bounds), but the engine accepts any valid action.

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

**Challenge details (decided 2026-10-12).** The spec left these open:

- Presence shows `T` distinct targets, of which T/2 − 1 to T/2 + 1 are real (live values) and the rest are decoys. A decoy is a ghost (a deleted value) or a value the enemy can never emit, chosen with equal chance while ghosts last. Target order is shuffled. With fewer live values than wanted, the extra targets are decoys.
- A Presence strike names targets by position in the shown list, starting at 0, with no repeats.
- A Frequency challenge cannot be issued when nothing is live.
- A Count estimate exactly on the edge of the tolerance band deals no damage and costs nothing. Beyond the edge it costs MISS\_PENALTY. With nothing live, only an estimate of 0 hits.
- Damage is rounded to six decimal places before it is applied.

**Risk choices the UI must support.** Targets flagged by two structures are marked as confirmed, so the player can strike only confirmed targets. For Frequency and Rank, the UI offers the structure's estimate, its upper bound, and a free number, so the player chooses between safe and greedy strikes.

Starting values: BASE 20, HIT\_DAMAGE 5, DECOY\_PENALTY 4, BLOCK\_PENALTY 3, MISS\_PENALTY 3, OVERSHOOT\_EXP 1, COUNT\_TOL 0.25, RANK\_TOL 0.1. All are placeholders until the simulator tunes them.

**Frequency falloff (changed 2026-10-15).** OVERSHOOT\_EXP was 2 and is now 1, so damage falls in proportion to the overshoot instead of its square. Measured with Minion Frequency fights (120 seeds, Greedy / Prober / Cautious / Random, win percent): with the starting loadout the exponent hardly mattered (75 / 63 / 3 to 28 / 4 to 8 at every value from 0.5 to 2), because Greedy strikes Exact Memory's figure, which is exact when the value is in its table and blocked when it is not. With a Count-Min Sketch owned, exponent 2 made the sketch a trap: it overshoots about three times on these streams, so damage fell to a ninth and Greedy won 32 percent against 75 for the Exact Memory gamble. At exponent 1 it is 78 / 38 / 47 / 6, so the sketch route is as good as the gamble for a careful player and still rewards skill. Exponents of 0.75 and below made Frequency nearly trivial with the sketch (Prober and Cautious about 78 percent, Random up to 10 and 16 percent).

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
| HyperLogLog (fusion) | MVP | Count | Space | 5 × m registers | Standard error about 1.04 / √m; counts empty registers (as Linear Counting) while that count is below 2.8 m | No |
| Cuckoo Filter | 2 | Presence | Space, fingerprint bits f | buckets × 4 × f | False positives about 8 / 2^f; inserts fail above about 95% load, after which false negatives appear | Yes |
| Count Sketch | 2 | Frequency | Space, depth d | 32 × w × d | Unbiased, error scales with the stream's L2 norm over √w | Yes |
| K-Minimum Values | 2 | Count, set math | Space | 32 × k | Relative error about 1 / √(k − 2) | No |
| MinHash | 2 | Likeness | Space | 32 × k | Jaccard standard error at most 1 / (2√k) | No |
| t-digest | 2 | Rank | Space (sets compression) | 64 per centroid | Most accurate at extreme quantiles; calibrate empirically | No |
| KLL Sketch | 2 | Rank | Space (sets k) | 32 per stored item | Uniform rank error shrinking with k; calibrate empirically | No |
| Quotient Filter | 3 | Presence | Space, remainder bits r | 2^q × (r + 3) | False positives about 2^(−r); mergeable | Yes |
| SimHash | 3 | Likeness | Space | 64 per fingerprint | Rough cosine similarity; weak on exact duplicates | No |

**Rules every implementation must follow**

- Structures that do not support deletes ignore delete events. That is the intended weakness against Churn, not a bug. Bloom Filter and Reservoir Sampling also count the delete events they ignore, and use the count to keep their ranges honest (see "Delete-blind ranges" below).
- Every query returns an estimate plus a low and high bound at a configured confidence (default 95%). For structures with one-sided error, one bound equals the estimate.
- Each structure gets a statistical test in the engine: over many seeded trials, its observed error must fall within its theoretical bound. Where no clean bound exists (t-digest, KLL), the test records an empirical table that the query uses for its bounds.

**Delete-blind ranges (decided 2026-10-14, refined the same day).** A range is a claim about the answer to the challenge, and a challenge asks about values that are live now. A structure that ignores deletes keeps counting or flagging deleted values (ghosts), so its range can miss the live truth. Measured in play, a Bloom Filter's Presence range held the truth 100, 51 and 29 percent of the time with no, some and many deletes, against a claimed 95.

- Bloom Filter and Reservoir Sampling keep two counters: `d`, the delete events they ignored, and the inserts they saw. They do not remove anything; they only count. Every ghost needs at least one delete, so there are never more than `d` ghosts, and `q = d / inserts` is the share of inserted units that have been deleted. The counters are not charged against Space.
- **Presence (Bloom Filter and Reservoir Sampling):** the low bound is widened by `min(d, flagged)`, so for Bloom `low = max(0, flagged - collisions - min(d, flagged))`. The high bound is unchanged. This is the worst case and it is deliberately not made smarter: which targets are ghosts is decided by how the challenge chose them, not by how many ghosts exist. Tested against the game's own challenge builder, a bound that assumed each flagged value is a ghost with chance `q` held the truth in only 57 percent of challenges at 10 percent Churn.
- **Reservoir Sampling, Frequency:** each inserted unit is treated as deleted independently with chance `q`, so the live count is the ever-inserted count thinned by `q`. The estimate is the ever-inserted estimate times `(1 - q)`. The range combines the sampling uncertainty (the exact binomial interval) with the thinning (a binomial in `q`), each side of each source being allowed a quarter of the chance of a miss. Without a sample (everything fits) the whole budget goes to the thinning.
- **Reservoir Sampling, Count:** a value is a ghost with chance at most `q`, so the ghosts are at most a binomial in `q` at the stated confidence. The low bound is the ever-inserted low bound minus that. The high bound is unchanged, since live cannot exceed ever-inserted. The estimate is corrected as in the bullet on the Count estimate below.
- With no deletes seen, every range is exactly what it was before.
- The thinning treats deletes as hitting units at random, which is how the enemy generator deletes. Measured in play on Reservoir Sampling, including growing bursts and drifting favorites, these ranges held the truth 99 to 100 percent of the time, and a low bound of zero fell from every answer to under 15 percent (Count: none) at Medium Churn.
- Under real Churn the Presence low bound is still usually 0 for Bloom Filter and Reservoir Sampling. The high bound stays informative, and it is the bound a player strikes at to avoid being blocked.
- **Linear Counting and LogLog, Count:** they also keep the inserts and deletes they see, and use the same rule as Reservoir Sampling's Count. The low bound is lowered by the ghosts: at most a binomial in the deleted share, and never more than the number of deletes. The high bound is unchanged. When any delete has been seen, the structure's own range is computed at 97.5 percent instead of 95, so the chance of a miss is shared between it (a quarter to each side) and the ghosts (a half). With no deletes seen, nothing changes. Measured in play, Linear Counting's range held the truth 94, 100 and 100 percent of the time with no, some and many deletes (it was 96, 0 and 0), and its low bound is never 0. The price is width, which grows with Churn.
- **The Count estimate (decided 2026-10-14).** The estimate of a Count answer (Linear Counting, LogLog, Reservoir Sampling) aims at the values live now: the ever-inserted estimate times `1 - g`, where `g = q * exp(-(m - 1)(1 - q))`, `q` is the deleted share and `m = inserts / ever-inserted estimate` is the average number of units per value (at least 1). It treats each unit as deleted independently with chance `q` and the units per value as one plus a Poisson number, so a value is a ghost only when all its units go: `g = q` when every value appears once, and close to 0 when values repeat a lot. `g` never exceeds `q`. The estimate is kept inside the range, and the range is unchanged by this. With no deletes seen, nothing changes. Measured for Linear Counting in play (4,096 bits, 200 fights per cell), the estimate was 11 percent above the live count at Medium Churn and 66.5 percent at High before, and is 1.3 and 4.1 percent above now. On the enemy streams it stays within 8 percent of the live count where most values appear once, and within 20 percent where values repeat a lot. **Known limit:** when a few heavy favorites carry most units and the rest of the values appear once (Skew High with High Churn), the Poisson model underestimates the ghosts, and the estimate stays 25 to 35 percent high (it was 53 to 62 percent).
- LogLog's range still misses the live truth on small streams even with no deletes at all (71 to 85 percent in range in play, where its register count is close to the number of distinct values). That is its intended weakness and this decision does not change it; the HyperLogLog fusion is its remedy. Inside its valid regime (many more distinct values than registers) its ranges hold the truth under every Churn, Growth and Drift mix tested.

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

**Stream generator details (decided 2026-10-11).** The spec left these open:

- Turn 1 is the base burst, so the growth exponent is t − 1 (turn 2 is ×1.15 at Medium).
- Drift runs before the burst of every turn divisible by its interval (turns 4, 8, ... at Medium). It reshuffles which values hold the top `fraction` of ranks; lower ranks keep their values.
- A delete removes one live unit chosen uniformly at random, so values are deleted in proportion to how much of them is live. When nothing is live, the event is an insert.
- The rank-to-value mapping is a keyed permutation rebuilt from the seed and the number of drift events. The saved state stays a few hundred bytes even at 2^22 values.

**Enemy design (decided 2026-10-13).** The spec gives trait counts per tier but not how an enemy is chosen:

- An enemy picks its non-Low traits at random from the five the stream generator implements (Variety, Skew, Churn, Growth, Drift). Each is High with the tier's `highChance` and Medium otherwise. Likeness and Cunning join the pool with M9.
- Weak points are drawn without repeats, in proportion to a base weight plus hints from the traits (`traits.json`). The hint table is a placeholder: Skew and Drift point at Frequency, Variety at Count, Churn and Growth at Presence.
- Tier numbers (Size, HP, attack, turn limit, trait and weak point counts, High chance) are placeholders in `balance.json` for the simulator to tune. An Elite has one or two weak points and a Boss two.

**Challenge generation.** Presence decoys are values never inserted, plus deleted values (ghosts). Likeness copies are generated as mutated subsets of the live set, with real copies above LIKE\_THRESHOLD and decoys placed per the Likeness trait.

**Cunning, implemented literally.** Unseeded structures hash with a fixed public seed, so the enemy can attack them for real, within a search budget of CUNNING\_SEARCH (default 50,000 candidates per turn):

- Against Bloom-style filters, it searches for values the player's current filter wrongly reports as present and uses them as Presence decoys.
- Against Count-Min, it inserts values that collide with its core value's counters, inflating the overestimate.
- Against LogLog and HyperLogLog, it inserts values whose hashes have many leading zeros, inflating Count estimates.

A Seeded structure uses a per-fight secret seed. The enemy keeps attacking with the public seed, which then has no special effect. The engine must not peek at the secret seed when generating adversarial values.

## Run structure and rewards

The MVP run is one act: five fights, one rest stop, one Elite, then a Boss. The full game has three acts.

- **Starting loadout (changed 2026-10-14):** Exact Memory, Reservoir Sampling, Bloom Filter, Linear Counting (four owned, three slots, so every fight asks the player to choose); 8,192 bits; 150 Certainty (100 until 2026-10-17). With the original three, a Count Minion was lost by every bot (0 percent): Exact Memory fills after 128 values, Reservoir Sampling's distinct estimate is too coarse for the tolerance, and Bloom Filter cannot count. Adding Linear Counting won 96 percent of Count Minions (mean of the Greedy, Prober and Cautious bots, 100 seeds each) and raised the natural Minion win rate from 44 to 72 percent and Elite from 20 to between 37 and 44 (two seed sets), with Presence and Frequency unchanged within noise. Exact Memory stays, because dropping it cost Frequency (43 to 26 percent). Count-Min Sketch was not added: alone it fixed nothing for Count and did not help the bots at Frequency.
- **After each fight:** pick 1 of 3 rewards, drawn from new structures, upgrades, and enchantments. Weights live in `content/balance.json`.
- **Rest stop:** perform fusions, move enchantments between structures, and restore REST\_HEAL Certainty (default 30).
- **Enemy pacing:** trait count and levels rise through the act. Minions have 1–2 non-Low traits, Elites 3, the Boss 4 plus two weak points.
- **End of run:** win or lose, the player can export the toolkit built so far.

**Run loop, step 1 (decided 2026-10-15).** The spec left these open. The run is plain data in the engine (`createRun`, `stepRun`, `legalRunActions`, `observeRun`, `turnsTaken`; the fight's own `step` and `legalActions` keep their names), and the content package builds its `RunConfig` from a run seed (`buildRunConfig`):

- **The act** is `RUN_ENCOUNTERS`: five Minions, an Elite, then the Boss. The rest stop comes before the Elite (`REST_BEFORE` [5]), so the fifth fight's reward is chosen first. The run is won by beating the last encounter and lost with the first lost fight.
- **Certainty carries from one fight to the next** (the current spec; it stays an open question below). Each fight starts with the run's Certainty.
- **Rewards** are offered after every won fight except the last: `REWARD_CHOICES` (3) distinct ones, drawn one at a time without replacement in proportion to `REWARD_WEIGHTS` (structure 3, upgrade 2), from a stream of the run seed. A structure the player already owns is never offered, a weight of 0 never is, fewer are offered when fewer are eligible, and the reward phase is skipped when none is. The pool is the structures not in the starting loadout plus the five upgrades.
- **Upgrades** are in `upgrades.json` (name, summary, effect) and stack. Capacity and Slots apply to every later fight. Resolve raises the maximum and, at once, the current Certainty. Recovery restores Certainty after each won fight, up to the maximum. Power multiplies the damage of every strike (`damageMultiplier` in the fight rules, so the narrated damage is the real damage).
- **The rest stop** restores `REST_HEAL` Certainty up to the maximum. Its only action for now is `leaveRest`; fusions and enchantments come in later steps.
- **Seeds:** fight `i` uses `<run seed>/fight/<i>` and encounter `i` is designed from `<run seed>/encounter/<i>`, so the encounters do not copy each other and adding rewards never shifts a stream.
- A scripted run that strikes the true answer every time wins the whole act on the real content (test), so Certainty carry-over alone does not make the act unwinnable. Whether the bots win it at the spec's balance targets is step 4.

**HyperLogLog and fusions (decided 2026-10-15).**

- **The structure.** HyperLogLog has m = the largest power of two that fits in Space / 5 registers (at least 16). The estimate is the harmonic mean `alpha_m m^2 / sum(2^-M_j)`; but while the count of empty registers, `m ln(m / V)`, is at most `HLL_SMALL_RANGE` (2.8) times m, it uses that count instead, as Linear Counting does. The range is the estimate plus or minus z times the error: Linear Counting's own error law while it counts empty registers, otherwise `HLL_ERROR_COEFFICIENT` (1.04) / √m. It ignores deletes and handles them as LogLog and Linear Counting do (the ghosts range and the live-share estimate above). Registers merge by maximum.
- **Measured** (1,024 registers, 1,000 seeded trials per size, RMS relative error against the spec's 1.04 / √m = 3.25%): between 2.3% and 3.3% at every stream size from 500 to 100,000 values except around the switch, where both estimators are about equally noisy and the worst case is 3.57% (1.10 times the theory). The switch is decided on the empty-register count, which is less noisy than the harmonic mean, and 2.8 m was the threshold with the smallest worst case (2.5 m gave 3.86%). The test allows 1.10 times the theory away from the switch and 1.15 times around it, and requires the range to cover the truth at the stated confidence at every size.
- **Recipes** are in `fusions.json` (id, inputs, result, summary, phase) and passed to the engine as `RunConfig.fusions`. At a rest stop the player may `fuse` any recipe whose inputs are all owned and whose result is not; the inputs are consumed, the result is added to the owned structures, and it takes one slot when deployed. Fusing does not end the rest stop. A fusion result is never found as a reward, and a consumed structure is not offered again. The HyperLogLog recipe is LogLog + Linear Counting; its in-game summary says it is a teaching shortcut.

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

**Bot details (decided 2026-10-13).** The spec left these open:

- Bots choose from what a player sees (`observe`), so they cannot read the true answers. Only the Oracle is given them. `legalActions` is a finite representative list, so Random draws from that list.
- **Greedy** ranks weak points by the trait hints, deploys one best-matching owned structure for each of the two likeliest, splitting the Space evenly, and strikes on the best-suited structure's estimate (for Presence, everything that structure flagged). Once the weak point is revealed it removes structures that do not help and deploys the right one. With no answer to use, it strikes minimally.
- **Prober** spends 40 percent of the first turn's Space on Reservoir Sampling, which can answer any question, keeps it, and otherwise plays like Greedy.
- **Cautious** deploys two structures per weak point so answers can be cross-checked, strikes only Presence targets that two or more structures flagged (nothing if none), strikes Frequency at the upper bound, and strikes Count at the estimate.
- **Oracle** deploys nothing and strikes exactly: the true count, the true distinct count, or exactly the real Presence targets.
- A fight a bot has not finished within a step limit is recorded as stalled.

**Commands**

```
pnpm sim fights --bot greedy --n 10000 --seed-base 1     # fight-level stats
pnpm sim runs --bot prober --n 2000                       # full-run stats
pnpm sim compare --bots greedy,prober,cautious --n 5000   # side by side
```

**Report metrics:** win rate, turns per fight, Certainty lost by cause, structure deploy and win rates, and observed error rate per structure versus theory.

**Report details (decided 2026-10-13).** The spec left these open:

- `sim fights` and `sim compare` work on single fights. `sim runs` plays whole runs (see "Whole runs" below).
- Fight `i` of a batch uses the seed `seed-base + i`, and `compare` uses the same seeds for every bot, so a report is reproducible and bots face the same enemies. Options are `--n`, `--seed-base`, `--tier` (default `minion`), `--loadout` (`starting` or `full`, default `starting`) and `--json`.
- The win rate comes with a 95 percent Wilson interval.
- "Observed error versus theory" is measured in play: at every strike, each deployed structure's range is checked against the true answer, and the report gives how often it held the truth against the confidence the structure claimed, plus the mean relative error of its estimate. A structure deployed late is judged on a stream it only partly saw, and a structure that cannot see deletes is judged on a stream with deletes, so these figures include the game's intended weaknesses. The structures' own statistical tests cover the no-weakness case.
- **Count duel (decided 2026-10-14).** Every report also compares LogLog with Linear Counting at each Count challenge, whatever the bot deployed: both are given all of `STARTING_SPACE` and shown the values the enemy has inserted so far (live values and ghosts, once each, since neither can delete). The report gives how often LogLog's estimate was strictly closer to the true distinct count, the number of fights with a Count challenge, and the most distinct values the counters had seen at one challenge. It exists to show whether the stream sizes in `TIERS` ever reach the range where LogLog wins (about 50,000 distinct values at 8,192 bits). Figures depend on how long the bot's fights last.
- "Wrong strikes" is the share of strikes that were blocked, missed the Count band, or hit a decoy.

**Whole runs (decided 2026-10-16).** `pnpm sim runs --bot <name> --n <runs> --seed-base <n> [--json]` plays whole acts (`--bots a,b,c` compares several on the same seeds); run `i` uses the run seed `seed-base + i` and the act `buildRunConfig` designs from it. The fight-level bots play the fights unchanged (a new player for each fight). What they do outside a fight is a run policy: Random picks any reward and any rest action with equal chance, and the others take a new structure before an upgrade (Count-Min Sketch, then LogLog), then upgrades in the order Power, Resolve, Recovery, Capacity, Slots, and fuse whenever a fusion is available. That order is a bot's taste, not a game rule. The report gives the win rate with a Wilson interval, fights won per run, where the lost runs ended, the win rate of the fights of each tier, and for the won runs the turns, Certainty left, structures deployed, first structure deployed (the opener) and the share that fused; and it checks the targets below. A structure "appears" in a run if it was deployed in at least one fight. Wrong strikes are the share of strikes that were blocked, missed the Count band or hit a decoy (spec: "10 to 30 percent of turns", read per strike). Targets are checked only for the bots measured: win rates for Greedy, Random and Oracle; Greedy's wrong strikes; and the opener and structure targets over the winning runs of the Greedy family (Greedy, Prober and Cautious) pooled, each bot counting in proportion to its wins, because the Prober opens with Reservoir Sampling by definition and Greedy never prefers it. The report also counts, for each tier, the fights lost to the turn limit as opposed to running out of Certainty.

**Balance targets** (initial, revisit after playtesting):

- Greedy wins 55–70% of MVP runs; Random wins under 5%; Oracle wins over 95%.
- No single opener is used in more than 40% of winning Greedy-family runs.
- Wrong-answer strikes occur on 10–30% of turns, so error is felt but not dominant.
- Each MVP structure appears in at least 15% of winning runs.

**Run tuning (changed 2026-10-17).** The first whole-run numbers (300 runs, seeds 1 to 300) showed the act far too hard: Greedy won 1.3 percent of runs, Prober and Cautious none, Random none and the Oracle all. Greedy won 92 percent of Minion fights, 62 percent of Elite fights and 3 percent of Boss fights. A lever sweep (Greedy, 100 to 200 runs) found enemy HP the strongest lever, then the Certainty pool; extra turns did nothing until HP was low, then little; attack and the rest heal did little. Elite and Boss HP at a quarter alone gave 37 to 42 percent, held back by the Minions (five fights in a row at 93 percent is 70 percent). `STARTING_CERTAINTY` is now **150** and the tier HP is **Minion 20, Elite 30, Boss 50** (was 100, and 40, 90, 200), which keeps HP rising by tier. With these, the same 300 runs: Random 0.3 percent, **Greedy 47.7**, Prober 29.7, Cautious 12.0, Oracle 100; Greedy wins 97 percent of Minion fights, 83 of Elite and 66 of Boss. The tier size, attack and turn-limit numbers are unchanged.

**Targets after the tuning (300 runs).** Met: Random under 5 percent (0.3), Oracle over 95 (100), no opener over 40 percent of the Greedy family's winning runs (the largest is Reservoir Sampling at 33.2), every MVP structure in at least 15 percent of those runs (all six). **Missed, documented as deviations:** Greedy wins 47.7 percent against 55 to 70, and its wrong strikes are 37.6 percent against 10 to 30. The remaining losses are Frequency fights lost to the turn limit (with a mid-run kit Greedy wins Presence 100 percent, Count 85 to 99 and Frequency 77 to 91): they come from how Greedy and the structures find the shielded value's count, which the damage numbers do not fix (OVERSHOOT\_EXP between 0.5 and 1, turn limits up to 16, and more Certainty were tried and moved Greedy by 2 points at most). Watching the lost fights shows why: the Count-Min Sketch, given 4,096 bits, has 32 columns (32-bit counters, depth 4), so every counter holds about N / 32 of the stream and its estimate is many times the true count (51 for a true 3, 1,298 for a true 11) while its low bound is 0; the strikes then deal about 1 percent damage and the fight ends at the turn limit. Closing the gap is a structure question, not a tier-numbers one, and is deferred to the Phase 2 structures (decided 2026-10-17). Wrong strikes rose from 28 to 38 percent because the shorter fights are a larger share of early, poorly informed strikes.

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

**Command details (decided 2026-10-13).** The spec left these open:

- Slots and targets are numbered from 1 for the player; the engine counts from 0.
- `deploy` places the structure in the first free slot. A structure is named by its short alias (`bloom`, `cms`, `loglog`, `linear`, `exact`, `reservoir`) or its full name.
- `strike high`, `low` and `estimate` use the first deployed structure that has a numeric answer. `strike high 2` names the structure by slot. The result says which structure was used.
- `strike confirmed` strikes the targets flagged by two or more structures, `strike flagged` those flagged by any, and `strike none` strikes nothing. A bare number is a force for Frequency and an estimate for Count, and a list of numbers is a set of targets for Presence.
- The parser never throws. A bad command returns an explanation, with a suggestion for a likely typo.
- The status and query screens are laid out in code; the story text, enemy descriptions and command help come from `narration.json`.

**Terminal game (decided 2026-10-14).** `pnpm cli` plays one fight:

- Options: `--seed <text>` (default: the clock, and the seed is printed so a fight can be replayed), `--tier minion|elite|boss` (default `minion`), `--loadout starting|full` (default `starting`).
- A `Session` holds the fight and turns one typed line into lines of output with no I/O of its own, so a script of lines gives a transcript and the tests run whole fights. A thin loop feeds it lines from the terminal.
- The prompt shows the turn, phase, Certainty, enemy HP and free Space. When a challenge arrives, the answers of the deployed structures (the `query` screen) are printed with it.
- The welcome and goodbye lines are in `narration.json` under `game`.
- A run is one fight for now; the run loop (rewards, rest stops, fusion) is Milestone 4.
- **Strike feedback (decided 2026-10-14).** After a strike the game says what was true, so the player can learn how far off a range was: a Frequency strike reports the true count and the force used, a Count strike the true number of distinct values and the estimate used, a Presence strike how many of the targets were real. The truth is part of the `strikeResolved` event (`trueCount` and `force`, `trueDistinct` and `estimate`, `realTotal`); it appears only after the strike, never in an Observation. The first playtest found that without it a player cannot tell a good range from a bad one.
- `help` lists only the structures in the loadout; asking about another one still explains it and says it is not owned. On a Presence challenge turn the targets are printed once, in the query screen with the structures' flags.

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
- Should Exact Memory stay in the starting loadout, or be a reward so early fights force sketch use? (Kept for now: removing it cost Frequency fights; see the starting loadout.)
- Weak point reveal: on the first challenge (current spec), or only through probing?
- Export languages after TypeScript and Python: Go, Rust, or Java?
- Leaderboard hosting for speedruns: static seeds published in-repo first, server later?
- All values in balance.json and the trait tables are starting guesses until M3 and M4 simulations tune them.
