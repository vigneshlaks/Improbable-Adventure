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

**No action loops (decided 2026-10-18; rules version 2).** Deploying and removing cost no turn, and a removal refunds all its Space, so a deploy followed by a removal returns the game to exactly the state before it. The first learned player (M8) found this: in 26 of 400 held-out games it beat 1 to 6 enemies and then repeated `deploy` and `remove` on one slot for over 330 steps, never ending a turn, until the step limit cut the game off. (A deterministic policy that chooses the deploy in a state will choose it again in the identical state after the removal.) Every action that can repeat without spending a turn was listed: in a fight `deploy` and `remove`; at a rest stop `enchant` (moving an enchantment from one structure to another is free and reversible); `fuse` consumes its inputs and `chooseReward` happens once, so neither loops; `endDeploy` and the strikes end the deploy phase or the turn. Two limits close both:
- **Changes per turn.** A turn allows `DEPLOY_CHANGES_PER_SLOT` (2) deploys and removals in all per slot (6 at 3 slots, more with Slots upgrades), counting both kinds and not counting refused actions. When they are used up `legalActions` offers only `endDeploy`, and a deploy or removal is refused with "No more changes this turn". The count returns to zero when the next turn begins. `Observation.changesLeft` shows what remains. Two per slot lets a slot be filled, emptied and filled again in one turn, which covers re-planning, and no more.
- **Enchantments per rest stop.** At most `REST_ENCHANT_LIMIT` (6) attachments or moves at one rest stop, counted in `RunState.restEnchants` and `RunConfig.restEnchantLimit`; after that no `enchant` is offered and only fusions and `leaveRest` remain.
- **Why a limit and not "cannot undo the previous action".** Forbidding an immediate undo would also forbid correcting a mistake, and does not stop a cycle of three. A budget bounds every sequence: a fight takes at most `turn limit x (changes per turn + 2)` accepted actions (the changes, one `endDeploy`, one strike each turn), and a rest stop at most `REST_ENCHANT_LIMIT` plus the fusions plus one `leaveRest`.
- **Test.** `run/progress.test.ts`: a player who always takes a turn-free action when one is offered is stopped within the bound for 1, 2, 3 and 5 slots and turn limits of 2, 4 and 6 (and the fight is lost to the turn limit); the same player at a rest stop with spare enchantments shuffles up to the limit and then leaves; and 150 sequences of arbitrary actions, most of them refused, never go past the turn limit, never exceed either budget, and end.
- **Consequences.** `ENGINE_VERSION` is 2, so replays recorded under version 1 report `version` (they re-play only on the engine that recorded them); the five replays in `replays/` were re-recorded. The learning environment's observation gains `changesLeft` as a share of a turn's allowance (the agent can see its budget run out; 208 numbers, 267 actions), and its mask already follows the engine's legal actions, so deploys and removals switch off by themselves. The status screen says "Changes left this turn". A test plays the stalling policy through the environment: it ends the game by itself (a loss) well inside the 400-step limit.
- **The 26 games, in detail.** The trained agent (M8, `ppo-h`) was replayed on the two held-out seed sets under rules version 1: 12 and 14 games reached the 400-step limit. In all 26 the action list ends in a strict two-step cycle, `deploy <structure> in slot N` then `remove slot N`, with the structure and slot varying by game (Exact Memory 12, Reservoir Sampling 7, Linear Counting 4, and one each of Bloom Filter, LogLog and Count-Min). The cycle began between steps 23 and 79 and ran 320 to 377 steps. By then the agent had finished 1 to 6 fights: 15 games stood in fight 6 (the Elite), 8 in fight 7 (the Boss), and 1 each in fights 5, 3 and 2. The agent was never close to dying in a cycle: it simply stopped taking the strike-and-endDeploy actions that advance a fight. The most likely reason is its reward: a cut-off cost the run-loss weight (the same as losing), and from that state, deploying then removing is a move that leaves the value estimate unchanged, so a policy that picks the highest-valued action deterministically repeats it. Counted over its 400 steps, such a game had 5 to 23 strikes against 163 to 195 removals.

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

**Phase 2, step 1: Count Sketch and the Top-K Tracker (decided 2026-10-18, M9).** The first slice of M9, chosen to revisit the Frequency gap. Both answer Frequency only.
- **Count Sketch** (`countSketch`, aliases `countsketch`, `csketch`; reward). A grid of depth rows by width columns of signed 32-bit counters (32 x w x d bits; depth is the knob, default `COUNT_SKETCH_DEFAULT_DEPTH` 5, odd so the median is a row's own estimate). Each row has its own seeded bucket hash and sign hash. An insert adds the value's sign to its counter in every row, a delete subtracts it (so deletes are exact), and the estimate is the median over the rows of sign x counter, clamped at zero. It is unbiased and can answer below the truth as well as above it. **Range:** `estimate +- band`, with `band = m x sqrt(F2 / width)`, where `F2` is the stream's squared L2 norm, estimated as the median over the rows of the sum of squared counters (each row's sum is unbiased), and `m` is the smallest multiple for which a median of `d` rows exceeds it with chance at most `1 - CONFIDENCE`: each row is off by more than `m` typical errors with chance at most `1 / m^2` (Chebyshev), and the median is only that far off if at least `ceil(d / 2)` rows are (`medianBandMultiplier`, built on `binomialTail`). That is distribution-free and therefore conservative: it held the truth well over 95 percent of the time in tests. Tests: unbiased (mean error near zero over 200 seeded streams with churn and skew), coverage at least the stated confidence, and exact arithmetic for the band, the norm and the multiplier.
- **Top-K Tracker** (`topKTracker`, aliases `topk`, `tracker`; **a fusion**, not a reward): `countMinSketch` + `exactMemory` at a rest stop. A Count-Min grid (the knob is its depth) and a list of candidates in `TOPK_SHARE` (a quarter) of the Space, 96 bits an entry (the value and two ends). A value joins the list when the list has room or its Count-Min estimate beats the weakest candidate's upper bound; it enters with the interval `[max(1, floor(estimate - band)), estimate]` (the grid never underestimates, so the upper end is certain; the lower end holds with the grid's confidence), and every later insert or delete of it moves both ends by exactly one (a value whose upper end reaches zero leaves the list). A value that joined early, while the band was narrow, keeps a narrow interval however big the stream grows. A value not on the list is answered by the grid. The upper bound is never below the truth. At 8,192 bits and depth 4 it has a 48-column grid and 21 candidates. Tests: the upper bound never below the truth over 200 skewed streams with 10 percent churn, the lower bound at the grid's confidence, and the heaviest five values answered with less than half a plain Count-Min's error at the same Space (measured: 3.8 against 16.2 on average) while on flat streams it gains nothing (23.1 against 19.9). A bug the simulator found: the lower bound was a fraction, which broke snapshots; it is rounded down now, and the test checks every trial.
- **What they do for Frequency** (first Frequency strike of a fight whose only weak point is Frequency, one structure given all 8,192 bits, 150 seeds, mean damage out of a maximum of 20 and the share blocked; the strike is on the structure's estimate; Boss streams, Variety High):

| Structure | Skew Low | Skew Medium | Skew High |
| --- | --- | --- | --- |
| Exact Memory | 0.4 (98% blocked) | 14.4 (28%) | 20.0 |
| Reservoir Sampling | 0.2 (92%) | 7.4 (48%) | 9.9 (45%) |
| Count-Min Sketch | 0.6 | 8.6 | 19.4 |
| Count Sketch, on its estimate | 4.5 (53% blocked) | 8.3 (55%) | 10.8 (45%) |
| Count Sketch, on its upper bound | 1.5 | 12.1 | 14.5 |
| Top-K Tracker | 0.4 | 14.4 | 20.0 |

  Variety Medium streams give the same picture with larger numbers (Top-K Tracker 18.9 at Skew Medium against Count-Min's 14.9). Reading: **High Skew was never the gap** (Count-Min already deals 19.4 of 20). The **Top-K Tracker closes the Medium Skew gap** (it matches Exact Memory without needing the table to hold every value). **A flat stream stays unsolved by every structure** at 8,192 bits: the true count of the shielded value is 1 or 2, and any sketch's collision noise is larger than that; the best, Count Sketch, deals 4.5 to 7.9 on its estimate but is blocked half the time, because an unbiased estimate falls below the true count half the time. That is the structure's trade-off, not a defect: striking on its upper bound never blocks and deals less. The gap that remains is inherent to the question, not to the Phase 1 structures.
- **Bots.** Frequency preference is the Top-K Tracker first when Skew is not Low (then Count-Min), and the sensible rest-stop policy fuses HyperLogLog first and a Top-K Tracker next (it used to fuse the first recipe it found, which, with the new recipe, consumed Count-Min and Exact Memory without deploying the result: Greedy fell from 46 to 40 percent). The bots do not take Count Sketch: on its estimate it is blocked half the time and Greedy fell to 41 percent with it. Whole runs, 300 seeds: Greedy 44.0 percent, Prober 29.0, Cautious 11.0, Random 0.3, Oracle 100: within noise of before (Greedy 46.7). Whole-run win rates barely move because Frequency is one of three question types and the Boss is lost mostly elsewhere.
- **Plumbing.** `STRUCTURE_KINDS` has nine kinds. The exporter had templates for seven at this point; M10 added the rest. The learning environment now has 267 actions and 207 observation numbers, so the trained agent of M8 (218 and 187) no longer fits and would have to be retrained. The web panel draws both as heatmaps. The MVP structure target (every MVP structure in at least 15 percent of winning runs) now counts only phase 1 structures.

**Phase 2, step 2: Cuckoo Filter and K-Minimum Values (decided 2026-10-18, M9).** Both are rewards (not in the loadout, not fusion results).
- **Cuckoo Filter** (`cuckooFilter`, alias `cuckoo`; Presence; the knob is the fingerprint size f, 1 to 16 bits, default `CUCKOO_FINGERPRINT_BITS` 8). A table of buckets of `CUCKOO_BUCKET_SIZE` (4) fingerprints, `floor(Space / (4 f))` buckets, so 256 buckets and 1,024 fingerprints at 8,192 bits and f = 8. A value's fingerprint (f bits, never zero) sits in one of two buckets: the one its hash picks, or `(H(fingerprint) - bucket) mod buckets`, which maps each bucket of a pair to the other for any bucket count (not only a power of two), so a fingerprint can be moved without its value. An insert takes a free place in either bucket; if both are full it pushes a fingerprint to its other bucket, and so on, up to `CUCKOO_MAX_KICKS` (500) pushes, after which the fingerprint it holds is **dropped** and counted (`lost`): that can hide one real value (a false negative). Which fingerprint to push is chosen by a hash of a counter kept in the state, not by a random generator, so the same inserts always make the same table and snapshots continue identically. A delete removes one matching fingerprint from either bucket, so unlike a Bloom Filter it handles Churn. A query flags a value whose fingerprint is in either of its buckets. **Range:** `low = flagged - binomialUpper(targets, p, confidence)` with `p = 1 - (1 - 1/(2^f - 1))^(2 x 4 x load)` (a stranger matches one of the up to eight fingerprints in its buckets; about 8 / 2^f at full load), and `high = min(targets, flagged + hidden)` with `hidden = min(unflagged, lost + binomialUpper(deletes, p, confidence))`: each dropped fingerprint hides at most one value, and each delete takes a look-alike's fingerprint instead of the value's own with at most chance `p` (this matters most for a structure deployed mid-stream, whose deletes are mostly of values it never saw). Tests: no value forgotten at up to 90 percent load (200 trials), the measured false-positive rate within 15 percent of the load's prediction and under 8 / 2^f, the rate right at f = 4, 8 and 12, the `low` bound at 85 percent load with decoys really flagged, the `high` bound overfull and with deletes, and with deletes of never-seen values (which hid real values in about 60 percent of challenges); an overfull filter loses fingerprints and says how many.
- **K-Minimum Values** (`kMinimumValues`, aliases `kmv`, `minvalues`; Count; no knob). Keeps the k smallest 32-bit hashes of the distinct values seen, `k = floor(Space / VALUE_BITS)` (256 at 8,192 bits). Below k different values the count is exact; from k on the estimate is `(k - 1) / u` with `u` the k-th smallest hash as a share of the range: unbiased, relative standard error about `1 / sqrt(k - 2)` (6.3 percent at k = 256). It ignores deletes and handles them as LogLog and Linear Counting do (`liveCountRange`: ghosts, the 97.5 percent range when any delete was seen). The range is lognormal around the estimate with that error (`est x exp(sigma^2 / 2 +- z sigma)`), exact below k. Two sketches of the same k and seed **merge** into the sketch of the union of their streams (the k smallest hashes of both), which is what the Theta Sketch fusion and multi-enemy fights will need. Tests: unbiased and an error within 15 percent of `1 / sqrt(k - 2)`, coverage at the stated confidence at Churn 0, 10 and 30 percent, the kept hashes equal to the k smallest of the stream, and the merge equal to one sketch that saw both.
- **What they do for the game** (first strike of a fight with a single weak point, one structure given all 8,192 bits, struck on its own estimate or flagged targets, 150 seeds, mean damage minus Certainty lost):

| Presence, Variety High | Bloom | Cuckoo |
| --- | --- | --- |
| Minion, Churn Low / Medium / High | 30.8 / 18.6 / 18.6 | 30.6 / 30.7 / 30.8 |
| Elite, Churn Low / Medium / High | 27.9 / 17.7 / 18.2 | 18.3 / 24.9 / 30.4 |
| Boss, Churn Low / Medium / High | 10.5 / 9.2 / 11.0 | 6.6 / 9.0 / 16.1 |

  Under Churn the Cuckoo Filter forgets what was deleted and the Bloom Filter does not, so it wins on Minions and Elites and at Boss Churn High. With no Churn on large streams it loses, because the table fills and drops fingerprints (Elite 18.3 against 27.9): a Cuckoo Filter has to be sized for the stream, a Bloom Filter degrades more gently. Count (Minion / Elite / Boss, any Variety and Churn Low or Medium): Linear Counting 19.4 to 19.6, K-Minimum Values 15.9 to 18.2, LogLog -3.0 on Minions and 16.1 to 18.0 on Elites and Bosses (it is badly biased on small streams), Exact Memory and Reservoir Sampling -3.0 almost everywhere. **K-Minimum Values does not beat Linear Counting at these stream sizes** (its error is 6.3 percent, Linear Counting's is under 2 while its bit array has room); what it adds is exactness up to k values and the merge, which pay off only with unions across streams.
- **Bots.** Presence preference puts the Cuckoo Filter first when Churn is not Low (if owned), otherwise the Bloom Filter. Whole runs, 600 seeds, Greedy / Prober: no Cuckoo preference 45.5 / 27.0 percent; preferred when owned 45.3 / 27.0 (the bots seldom own one, so no difference); preferred **and taken as a reward** 41.3 / 26.5 (Greedy: wrong strikes down from 41 to 36 percent and Certainty left up from 86 to 91, but 4 points fewer wins, probably because the pick displaces a better reward). The first behavior was chosen: the preference, with the reward taste unchanged. The bots do not use K-Minimum Values (nothing in the table above supports it).
- **Plumbing.** `STRUCTURE_KINDS` has eleven kinds; the exporter had templates for seven at this point (M10 added the rest). The learning environment has 267 + 12 actions and 208 observation numbers once the new kinds are counted (it must be retrained anyway). The panel draws the Cuckoo Filter as a meter of fingerprint places (with its load, false-alarm rate and dropped count) and K-Minimum Values as bars of the kept hashes.

**Phase 2, step 3a: the Rank challenge (decided 2026-10-18, M9).** The first of the two challenge kinds Phase 2 adds, with the structures that already can answer it.
- **Definition.** The rank of a value is the share of the live **units** (stream items, counting repeats) at or below it, from 0 to 1 (`LiveSet.rankOf`); the quantile value is the smallest live value whose rank reaches a quantile (`quantileValue`). Units, not distinct values, because that is what quantile sketches measure. A Rank challenge is `{ kind: "rank", quantile }`, cannot be issued with nothing live, and is answered with `strikeValue`. **Resolution** is formula 3 with the block rule: a value whose rank is below the armor's quantile is blocked and costs `BLOCK_PENALTY`; otherwise damage is `BASE x max(0, 1 - (rank - quantile) / RANK_TOL)`: full at the armor's own rank, nothing `RANK_TOL` (0.1) above it, and a strike that high is wasted, not punished. The result event carries the value struck, its true rank and the quantile.
- **The armor is snapped to an attainable rank (found by a test).** Issued at the enemy's nominal quantile exactly, a heavy value can span more of the ranks than `RANK_TOL` (a value holding 20 percent of the units jumps the rank by 0.2), so no value lands close enough and even the Oracle's best strike dealt nothing. The challenge therefore names `quantile = rank of the smallest live value that reaches the enemy's nominal quantile`: striking that value is a perfect hit, every lower value is blocked, and the percentage shown is a little above the nominal one. A test checks, on streams with one dominant value, two values and a single value, that the best value always deals full damage.
- **Enemies.** `EnemyConfig.rankQuantile` (needed when Rank is a weak point; validated 0 < q < 1). Content draws it from `RANK_QUANTILES` by tier (Minion 0.5; Elite 0.5 or 0.9; Boss 0.9 or 0.99). `traits.json` gets `rankWeight`, the base weight of Rank when an enemy draws weak points; **it ships at 0, so no enemy has Rank yet**, and weak points with no weight are never drawn (the enemies of the other three weak points are unchanged). Measured with `rankWeight` 0.5 (whole runs, 300 seeds): Greedy 43.7 -> 26.3 percent, Prober 26.3 -> 18.7, Cautious 9.3 -> 9.3, Oracle 100: the two structures that can answer Rank today are too coarse (Reservoir Sampling's range is about 8 percent of the ranks wide at 256 slots against a tolerance of 10) so the weight is to be raised when KLL and t-digest exist (Step 3b) and the balance re-tuned.
- **Answers.** `Answer.estimate` is the value at the quantile, and `low` and `high` bracket it: striking the upper end is the safe strike (it ranks at or above the armor with the stated confidence), the estimate is blocked about half the time. **Exact Memory** is exact from its table (every unit of a repeated value counts) and opens its range by the share of units it refused when full. **Reservoir Sampling** gives the sample's quantile with a distribution-free range from order statistics (`orderStatisticRange`: the number of sample values below the population quantile is Binomial(n, q), so the bracketing order statistics come from that alone), exact while it holds every unit with no deletes; deletes remove units at random, so they leave the quantile where it was and only add noise, which is added in quantile terms (`thinningShift`, a proportion's standard deviation over the units left) with the sample's range at half the chance of a miss. A sample too small to bound a high quantile from above says so (an infinite upper end). Tests: the range holds the true quantile value in at least the stated share of 200 streams, at Churn 0, 10 and 30 percent and quantiles 0.5 and 0.9; the order-statistic indices equal the binomial's, exactly; the ranges equal `orderStatisticRange` exactly.
- **Interfaces.** Narration: "The enemy wraps itself in armor at rank 90 percent: strike with a value that 90 percent of the values in its stream are at or below..." and strike lines giving the rank struck against the armor (no ordinals). The query screen asks the question and gives each structure's value and range; `strike estimate|high|low` work as for any number. The learning environment's observation gains the armor's quantile and a Rank weak-point and challenge flag (`WEAK_POINTS`), and the numeric strikes by meaning apply to Rank. Greedy strikes the upper end of the range against armor (it takes the estimate when there is none); the Oracle strikes the quantile value; the rank-answering preference is Reservoir Sampling, then Exact Memory. The field report notes a Rank strike as blocked ("too low"), sound, or wasteful (5 points or more above the armor).
- **A bot fix on the way.** The bots' minimum deploy size (256 bits) is below what a Top-K Tracker needs (384); a bot would deploy one in too little Space and be refused. Each structure now has its own minimum.

**Phase 2, step 3b and 3c: KLL Sketch and t-digest (decided 2026-10-18, M9).** The two quantile structures that answer Rank sharply. Both are rewards, answer Rank only, cannot delete (they count the deletes they see; deletes remove units at random, so they leave the quantile where it was and only add noise, allowed for as Reservoir Sampling's are, with `thinningShift`), and give a range around the quantile value with the stated confidence.
- **KLL Sketch** (`kllSketch.ts`, `KLL_RANK_ERROR` 1.6). Items in levels; an item at level l stands for 2^l units; a level over its capacity is sorted and every second item (from a coin that is a hash of a counter, so a stream always makes the same sketch) is promoted. Capacities fall by 2/3 per level going down. It costs 32 bits per stored item, with the top level k as large as the Space allows when planned for 24 levels. Exact while it holds every unit. The rank error is `KLL_RANK_ERROR / k` at every quantile, a coefficient **calibrated by simulation** (the 95th percentile of the measured error times k stays within it), not the theoretical bound, whose constant is far looser. Its range spans a much smaller share of the ranks than a Reservoir of the same Space (tested).
- **t-digest** (`tDigest.ts`, `TDIGEST_RANK_ERROR` 4). Weighted centroids; the scale function `k(q) = compression / (2 pi) x asin(2q - 1)` lets a centroid cover many units in the middle and few at either end, so it is **sharpest at extreme quantiles** (the 99th percentile is its use) and coarser in the middle, the opposite of KLL's uniform error. It costs 64 bits per slot (mean and weight), the compression is the slot count, and the smallest and largest value are kept exactly. The rank error is `TDIGEST_RANK_ERROR x sqrt(q (1 - q)) / compression`, again calibrated by simulation. A query merges a copy, so asking never changes it. Tested sharper than KLL at q = 0.01 and 0.99 and about as sharp in the middle, at the same Space.
- **Tests.** Parameters and costs; exact while small; size bounds however long the stream; snapshot, clone and determinism; the rank error against the true rank intervals; coverage of the range at the stated confidence at three (KLL) or four (t-digest) quantiles with and without Churn. Mutation checks: KLL 8 of 8 caught (after tests were added for three first survivors); t-digest 8 of 9. The survivor changes the inverse scale function's clamp from `k >= compression / 4` to `compression / 2`; the clamp only matters for the single last centroid (the other `k` values never reach it), and the changed value there differs from 1 by a negligible amount, so it is treated as an equivalent mutation.
- **Interfaces.** Both in `structures.json` (aliases `kll`; `tdigest`, `digest`), panel visuals as bars (each bar a stored item or centroid, as tall as the units it stands for), bots prefer t-digest, then KLL, then Reservoir Sampling, then Exact Memory for Rank. Rank enemies are switched on, see below.
- **Rank enemies on (`rankWeight` 0.2, decided 2026-10-18).** The bots take a t-digest or KLL Sketch as a reward after Count-Min, Count Sketch and LogLog (`runPolicy.ts`), and the bots' deploy minimums are per structure (KLL 1,536 bits). Whole runs, 300 seeds, Greedy / Prober / Cautious: Rank off 43.7 / 26.3 / 9.3; weight 0.5 with the new structures obtainable 28.0 / 17.0 / 9.3 (the Oracle stays at 100); **weight 0.2: 37.3 / 21.3 / 8.7**. 0.5 was too harsh because the starting kit cannot answer Rank and a bot only meets KLL or the t-digest as a reward; 0.2 keeps Rank a visible minority of enemies. The Greedy target (55 to 70 percent) was already missed and stays missed (cost of this step about 6 points); the learned player must be retrained.

**Phase 2, step 4: the Likeness challenge and MinHash (decided 2026-10-18, M9).**
- **Challenge.** `{ kind: "likeness", targets: [0..K-1], copies, threshold }`: K copies (`LIKENESS_COPIES` 6), each a set of distinct values, named by position so a flagged subset reads as in Presence. A copy is **real if its Jaccard similarity to the live set (shared distinct values over distinct values in either) is at least `LIKE_THRESHOLD`** (0.6), exactly (`jaccardToLive`; equal to the threshold is real). **Resolution is Presence's**: `HIT_DAMAGE` per real copy struck, `DECOY_PENALTY` per decoy (`likenessStrike`, result kind `likeness`).
- **Generation.** About half the copies are real (K/2 plus or minus one, at least 1 and at most K-1). A copy of target similarity J keeps `a` live values and adds `b` values that are not live (ghosts or never-inserted values, half and half), with `a / (L + b) = J` for L live values; real copies draw J from `LIKE_REAL_BAND` (0.66 to 0.95), decoys from the **Likeness trait's band** (`traits.json` levels: Low 0.05 to 0.3, Medium 0.35 to 0.5, High 0.5 to 0.58 – far, near, just under the threshold). The classification uses the copy's actual similarity, so rounding on small sets cannot mislabel. Copies are shuffled. **A challenge is only issued with between `LIKE_MIN_SET` (12) and `LIKE_MAX_SET` (1000) live distinct values** (the copies are as large as the set); otherwise the turn passes as for any challenge that cannot be asked. Ghost values in the copies mislead structures that cannot delete.
- **Enemies.** `StreamTraits.likeness` joins the trait pool (it does not shape the stream, only the decoys), `likenessWeight` 0 (so Likeness is drawn only through the trait's hints: Medium +0.5, High +1 in the weak-point weights). Measured whole runs, 300 seeds: with the weak point available Greedy / Prober fall from about 40 / 34 (when it is unreachable) to **35.7 / 26.7** (hints 0.5 and 1); hints 1 and 2 gave 31.5 / 25.5 and 2 and 5 gave about 8 for Greedy (the starting kit cannot answer Likeness: Exact Memory's table is far smaller than the set), so the shipped hints are the smallest tried. The `runReport` test's Greedy floor moved from 0.3 to 0.15 (it is a regression floor for a 60-run sample; Greedy wins 36 percent over 300 runs, 23 on those 60 seeds).
- **MinHash** (`minHash.ts`; Space 32 bits per slot, k = Space / 32, at least 8; ignores deletes like LogLog; reward, not in the loadout). Per slot the smallest hash of any value seen, with the slot's own hash function; a copy's signature is made on the spot, and the share of agreeing slots estimates the similarity with a standard error of at most 1 / (2 sqrt(k)) (tested: unbiased and within that, at J = 0.1, 0.5, 0.8). **Answer:** the flagged copies (`estimate`: positions with estimated similarity at least the threshold) and `low` / `high`, the number of **surely real** flagged copies and the number flagged. A flagged copy is surely real when `J - e - r >= threshold`, with e the Hoeffding half-width for its share of half the miss chance (shared among the K copies), and r the most that ghosts can be of the values ever inserted (a quarter of the miss chance to the lower bound for the distinct count, from the minima themselves: -ln(1 - m / 2^32) is exponential with rate n, so (k-1) over their sum is an unbiased estimate of the distinct values, with a lognormal lower bound; a quarter to the binomial bound for the ghosts); removing g ghosts from a union of U values moves a similarity by at most g / U, so the live similarity lies between J - e - r and (J + e) / (1 - r). Tested at the stated confidence with Churn 0, 0.1 and 0.3 on the challenges the game builds (the coverage is 1.000 in practice: the Hoeffding bound is conservative; the low bound is what is lost, 0.0 surely-real copies at Churn 0.3). A correction for the ghosts to expect (as K-Minimum Values uses) was tried for the flags and made them no better (more false flags at Churn 0.1), so the flags use the raw estimate: with Churn 0.3, 4 of 5 real copies are missed at 2,048 bits. Measured accuracy of the flags (copies classified right), 300 challenges: Churn 0 98 to 99.6 percent at 2,048 and 4,096 bits; 0.1 97 to 99; 0.3 86 to 88.
- **Exact Memory** answers Likeness from its table: a copy's similarity to the table is exact while the table has room; the values it refused (`missed` units) lower a similarity I / U to at least I / (U + missed), which is the surely-real edge. **Reservoir Sampling does not answer it** (a sample of units says too little about which values are in a set).
- **Interfaces.** Narration ("holds up 6 sets of values... a similarity of at least 60 percent"), the query screen lists the sets by size and marks the flagged ones, `strike` takes positions as in Presence, the panel draws one bar per MinHash slot, bots prefer MinHash then Exact Memory and take MinHash as a reward, the learning environment's observation has a sixth trait and a fifth weak-point flag and its strike actions work on Likeness as on Presence (the layout changed again, so the learned agent needs retraining), the field report counts Likeness strikes like Presence.

**Phase 2, step 5: the Cunning enemy (decided 2026-10-19, M9).** Cunning joins the trait pool (seven traits now) and makes Seeded a real reward.
- **What it does.** It searches `CUNNING_SEARCH` (50,000) candidate values per purpose per turn, all outside the enemy's own universe (`outsideValue`), using the **public hash seed**, against the structures deployed at that moment (`enemies/cunning.ts`):
  - **Count-Min Sketch:** it takes the values that share counters with the heaviest live value (the one a Frequency challenge shields) and inserts them where that value's counters are lowest, since the estimate is the smallest counter. A value that shares one row raises the minimum a quarter as far as the whole depth; measured on 60 inserted values at 4,096 bits: the heaviest value's estimate rises by 30 on average, against 1.6 for 60 random values and 2.1 against a secret seed.
  - **LogLog and HyperLogLog:** for each register it takes the candidate with the rarest hash pattern (the most leading zeros), the largest gains first. Measured: with as many crafted values as registers, an open LogLog or HyperLogLog (1,024 bits) estimates about 22,000 distinct values for a truth of 600, and a secret-seeded one about 700 to 800.
  - **Bloom Filter and Cuckoo Filter:** it looks for never-inserted values the filter flags, and offers them as Presence decoys. Measured: all 12 values it finds are flagged by an open Bloom Filter and none by a Seeded one.
- **How much.** `traits.json` `levels.cunning` gives, per level, `events`, the share of a burst's events that are crafted (0, 5, 15 percent; they are inserts **added to** the burst, so the stream is that much longer; the burst itself is unchanged), and `decoys`, the share of Presence decoys that are crafted (0, 50, 100 percent; the spec only gave the first). Crafted inserts go into the live set (they are real stream events, so they are in the truth).
- **Seeded defeats it by construction, and the engine never reads the secret.** `publicModel` takes the `hashSeed` out of a structure's snapshot before the enemy rebuilds the structure, so it reads the state as if hashed with the public seed. A test gives the same state with different secret seeds and sees the same crafted values. The enemy cannot aim at anything but Count-Min, LogLog, HyperLogLog, Bloom and Cuckoo (the structures with a search it can run); the others are unaffected.
- **Cost of the search and determinism.** `FightState.cunningCursor` advances two stretches (inserts, decoys) a turn, so every turn looks through new candidates; the search is a pure function of the structures' state, the heaviest value and the fight seed, so a replay is the same. Count-Min, LogLog, HyperLogLog get `probe(value)` (what an enemy that knows the hashes can read).
- **The stated confidence of the hashed structures does not hold against a Cunning enemy** that attacks them unseeded; that is the point of the trait, and the tests of the bounds use ordinary streams.
- **Enemy design.** Cunning has no weak-point hint. **Likeness is now a weak point only for a Low Variety enemy**, found by the oracle losing a run: an Elite with Likeness as its only weak point and a Medium Variety (about 3,500 live values) never got a Likeness challenge, because the game shows copies only for sets of at most `LIKE_MAX_SET` (1,000) values, and so could not be hurt.
- **Balance** (whole runs, 300 seeds, Greedy / Prober): Cunning off 43.7 / 31.0 (Rank and Likeness on); **Cunning on, Seeded offered and the bots attach it (to the Bloom Filter, then HyperLogLog, LogLog, Count-Min; Steady on Count-Min first): 37.0 / 24.0**; Cunning on and Seeded not offered 35.7 / 23.7. So Cunning costs about 7 points and Seeded wins back about 1 for the bots, which do not see the trait; a player who reads "studies your structures and aims values at them" and seeds the right one does better. Oracle 100.

**Phase 2, step 6: the Bloom fusions and the second-copy rule (decided 2026-10-19, M9).**
- **Same-kind recipes.** A recipe may name a kind twice (Bloom Filter + Bloom Filter). `RunState.owned` is a list, so it can hold two copies; a fusion needs as many copies of a kind as it names; **a structure reward for a kind is also offered when the kind is owned once and a still-open recipe needs two** (`copiesWanted`), including a starting kind (`buildRunConfig` adds those kinds to the reward pool). A fusion takes one copy per input; a kind that has been fused away (`consumed`) is never offered again. The fight's loadout lists a kind once (a second copy is only material for a fusion). Enchantments attach to the kind, so a doubled kind has one entry in the rest stop's choices and its enchantment returns once.
- **Scalable Bloom Filter** (`scalableBloom`, aliases `scalable`, `sbf`; fusion of two Bloom Filters). A stack of Bloom filters: the first layer takes `SCALABLE_BLOOM_FIRST_SHARE` (0.25) of the Space and is sized for a false-positive target `SCALABLE_BLOOM_TARGET` (0.005) with its bits per item `log2(1 / p) / ln 2`; when a layer holds as many values as it was sized for the next is added, twice the size (or what is left of the reserve) with the target times `SCALABLE_BLOOM_TIGHTENING` (0.5). A value that some layer already reports is not added (repeats do not use capacity). Present if any layer says so, so the rate it reports is `1 - product(1 - p_layer)` from the layers' fills; the Presence range is a Bloom filter's with that rate. Space reported is the whole budget. **Measured** (4,096 bits, 100 trials, 400 probes): false positives 0.05, 0.47, 0.62, 0.89 and 29.6 percent at 60, 120, 240, 330 and 480 values, equal to the rate it reports at every size (tested: within 1.3 times); a plain Bloom filter sized right for the stream (the default knob) is better (0.00, 0.00, 0.06, 0.27, 1.7), so this is a hedge for a stream of unknown size: against a plain filter sized for the first guess (93 values) it is 0.62 against 0.42 percent at 240 values... and 0.89 against 6.9 at 330 and 29.6 against 44 at 480. Past about 330 values its reserve is spent and the last layer saturates.
- **Spectral Bloom Filter** (`spectralBloom`, aliases `spectral`, `counting`; fusion of a Bloom Filter and a Count-Min Sketch; knob: expected items). One array of m = Space / `SPECTRAL_COUNTER_BITS` (16) counters shared by k hashes (k from the expected items as for a Bloom filter, default m / 5 items). Insert adds one to each counter, delete takes one off (exactly, so Churn is no problem; a counter at its top stops and is left alone and the estimate then has no upper bound). Presence: every counter above zero (tested equal to "the smallest counter is above zero"); Frequency: the smallest counter, **never below the truth** (tested with and without deletes), with Count-Min's band `e k N / m` at confidence `1 - e^-k` (measured on 300 streams per setting: the band held 100 percent of the time and the real overshoot was a fifth to a sixth of it, so it is conservative). Presence false positives are the share of counters in use to the k-th power (tested: within 1.3 times).
- **Mutation checks** (19): 16 caught at first, three survivors led to two tests (repeats not using capacity; presence being "every counter", not "some"); the others are equivalent (a `max(0, ...)` on an unsigned value; handing back an enchantment once whether or not the kind is read twice).
- **Bots** use a Spectral Bloom Filter for Presence under Churn only after a Cuckoo Filter and a Bloom Filter, and for Frequency after Count-Min and the Top-K Tracker, and Scalable under Growth; at a rest stop they fuse a Spectral Bloom after HyperLogLog and the Top-K Tracker. They never take a second Bloom Filter, so they never make a Scalable one.

**Phase 2, step 7: Dyadic Count-Min (decided 2026-10-19, M9).** Fusion of two Count-Min Sketches (a second copy turns up as a reward); answers Rank only; knob: depth of the sketches (default 3).
- **Structure.** A value is cut to its top `DYADIC_BITS` (8) bits, giving 256 ordered buckets (each 2^24 values wide). Level j counts every aligned run of 2^j buckets. A level with at most `DYADIC_EXACT_MAX` (64) intervals is exact (`DYADIC_EXACT_COUNTER_BITS` 16 bits each: levels 2 to 7 here); levels 0 and 1 are Count-Min sketches (32-bit counters) sharing the rest of the Space. A quantile is found by walking down from the whole range, going left when the target falls in the left half, with a child's count never above its parent's.
- **Answer.** `estimate` is the upper edge of the bucket found, `low` its lower edge, `high` the upper edge of the bucket found for the target plus the sum of the sketches' expected overshoots (`e N / width` each); **when that reaches past the total there is no upper end** (infinite `high`): the counts only overshoot, so the structure cannot say how far above the found bucket a high quantile lies. The reported confidence is the product of the sketches' `1 - e^-depth`. Deletes are exact. Tests: the true quantile value is inside the range at that confidence at 8,192 and 32,768 bits, Churn 0, 0.1, 0.3 and quantiles 0.5, 0.9, 0.99 (this first failed at q = 0.99: capping the upper walk at the total, instead of giving no upper end, was not a bound); the found bucket is never above the true one, even at the least Space; the range narrows as Space grows.
- **What it is for.** It is Space-hungry: at 8,192 bits the two sketch levels are 24 columns wide and the band is a few tenths of the units, so it gives wide ranges; a KLL Sketch is far sharper. It exists as the fusion the spec lists and for what it teaches (a quantile out of counters).
- **Mutation checks** (10): 8 caught at first; the other two (the sum of the bands, the product of the confidences) got exact checks; two remain that remove the rule that a child's count is at most its parent's, which none of the tests can tell apart (the fusion's guarantees hold without it at the Spaces tested); the clamp is kept as a consistency rule.

**Phase 3 structures: Quotient Filter and SimHash (decided 2026-10-19, M9).** Both are rewards (the spec's phase 3 structures, brought into the pool with the rest).
- **Quotient Filter** (`quotientFilter`, aliases `quotient`, `qf`; Presence; knob: remainder bits r, default `QUOTIENT_REMAINDER_BITS` 8, 1 to 16). A table of 2^q slots of r + 3 bits (the spec's cost), q the largest that fits the Space (8,192 bits at r = 8: 512 slots, 5,632 bits). A value's fingerprint is q + r bits of its hash; the structure keeps the **multiset of fingerprints** (one per insert, repeats too, so repeats use slots, as in the Cuckoo Filter), which is what the real table represents, **without simulating the occupied / continuation / shifted bits and the shifting of runs** (the behaviour the game and the bounds need does not depend on them; the metadata bits are paid for in the cost). A value is present if its fingerprint is held, so a stranger is flagged at the rate **distinct fingerprints / 2^(q + r)**, the load times 2^-r (tested within 1.3 times of what it reports at r = 4, 6, 8 and two loads). A delete removes one held copy exactly (it may be a look-alike's, at that same chance); a full table drops the next insert and counts it as lost, hiding its value. The Presence range is the Cuckoo Filter's: false alarms by a binomial at the rate, hidden real values from drops and from deletes of look-alikes. Two filters of the same shape and seed **merge** (every fingerprint of both, as far as the slots go). 13 mutations: 6 caught, the survivors (the exact fit of q, the rate counting distinct fingerprints, the delete term of the range, the lost count on merge) got tests.
- **SimHash** (`simHash`, aliases `simhash`, `angle`; Likeness; no knob). P planes, one per `SIMHASH_COUNTER_BITS` (16) bits of Space in whole 32-bit hashes (at least 64: one fingerprint); a value has a sign on each plane (a bit of its hash) and each plane keeps a counter of the signs it has seen; ignores deletes (counts them). A copy gets its signs the same way; the **share of planes where the two disagree estimates the angle over pi** (tested: the mean is acos(overlap)/pi and the spread is a binomial's over P, at overlaps 0.2, 0.5, 0.8). The cosine is shared / sqrt(stream size x copy size), so with the stream's **effective size** (n^2 over the mean squared counter, which is the sum of squared counts: exact when every value repeats equally, too small when a few repeat a lot) and the copy's, the similarity is I / (s + c - I) with I = cos x sqrt(s c). Flagged when that reaches the threshold; surely real when the far end of the angle (plus the Hoeffding half-width for its share of half the miss chance) still reaches it, less the ghosts a quarter of the miss chance allows. **It is the rougher of the two Likeness structures**: on streams without a dominant value it classifies about 80 to 89 percent of copies right at Churn 0 to 0.1 and 75 to 80 at 0.3 (MinHash 99 to 100, 87 to 89), with almost no false flags; on skewed streams, where a few values repeat a lot, it flags next to nothing (50 percent right: every real copy missed), which is the weakness on duplicates the spec gives. 14 mutations: 8 caught at first, the others got exact edge tests (the half-width, the ghosts, a copy's repeated values, the plane rounding); one remains that treats a zero counter as negative instead of positive, which changes the answer by nothing in expectation.
- **Bots** list Quotient after the Bloom Filter for Presence under Churn, SimHash last for Likeness.

**Phase 2, step 8: the Likeness fusions (decided 2026-10-19, M9).** Both answer Likeness only and are fusions (not rewards).
- **Locality-Sensitive Hashing** (`lsh`; MinHash + MinHash, so a second MinHash can be a reward). MinHash inside (same Space, slots, ghost handling, same "surely real" bound), with the minima read in **bands**: a copy is flagged when some band of r rows agrees with the stream's in every row, which a copy of similarity s does with chance `1 - (1 - s^r)^b` for b = k / r bands (tested within four standard errors at s = 0.3 to 0.8). r is **the most rows for which a copy exactly at the threshold is still flagged with chance `LSH_RECALL` (0.9)**, found from the slots and the challenge's threshold (5 rows at 256 slots, 3 at 64). So it **misses almost no real copy** (tested under 5 percent missed on the game's challenges) and flags many look-alikes: measured over 120 challenges, 4,096 bits, Churn 0: it classifies about 53 to 81 percent of copies right (the share falls as Space grows, since more bands let more decoys through) against MinHash's 98 to 100; `low` is the MinHash's surely-real count among the flagged. Its use is when a missed real copy costs more than a wrong flag, which in the damage rules (5 per real copy against 4 lost Certainty per decoy) is only sometimes.
- **HyperMinHash** (`hyperMinHash`; HyperLogLog + MinHash; Phase 3 in the spec's table). Registers of 5 + `HYPERMINHASH_MANTISSA_BITS` (3) = 8 bits, a power of two of them that fits the Space (256 at 2,048 bits against a MinHash's 64 slots): a value goes to one bucket (the first b bits of its hash) and the register keeps the code of the bucket's smallest hash (the position of the first one bit among the rest, then 3 mantissa bits; a larger code is a smaller hash, tested). Two sets agree in a bucket when the union's smallest hash is in both (chance J) or by chance (two different hashes, same code); the chance of the latter is measured on a **reference set of the copy's size from outside the stream's universe** and taken out: `(agreeing share - p) / (1 - p)` (p was 1 to 2 percent at 4,096 bits). The range is MinHash's with Hoeffding half-widths for the agreeing share and for p and the same ghost allowance (the distinct values from the registers' positions, as a HyperLogLog counts them, with its linear-counting range). **Measured** (120 challenges, 2,048 bits, per copy classified right): Churn 0 and 0.1: **100 percent** against MinHash's 99.2 and 98.3; Churn 0.3: 88 against 85; the range held at the stated confidence. So the fusion is the sharper judge, as the spec says ("Likeness at HyperLogLog's Space cost").
- **Mutation checks** (13): 8 caught at first; four survivors got tests (the chance correction as an exact formula and an exact edge of "surely real", the linear-counting branch of the count, the empty-signature rule of the bands); the other survivors do not change the result (a `>=` against `>` on a float equal to the recall; an early exit in the search for rows).
- **Bots** prefer HyperMinHash, MinHash, Exact Memory, SimHash and then LSH for Likeness; they do not make these fusions (HyperLogLog is the Count tool they keep).

**Phase 2, step 9: fights with two enemies, Merge and the Theta Sketch (decided 2026-10-19, M9).**
- **The fight.** `EnemyConfig.second` (`size`, `traits`) adds a second enemy that fights beside the first, with a stream of its own (`FightState.stream2`, `live2`, seeded `<seed>/second`). The two share one HP, one list of weak points and one turn limit; each turn both emit a burst. **Challenges are asked about the two live sets together** (`LiveSet.union`: every unit of both, a value live in either is live, a ghost only when live in neither), and strikes are graded against that union. A single-enemy fight's state has no `stream2` / `live2` and is as it was.
- **Which structure watches which enemy: the slot decides, with no new action.** Even slots (the 1st, 3rd, ...) watch the first enemy, odd slots (2nd, 4th, ...) the second; a structure hears only its enemy's bursts. The player picks the enemy by picking the slot: `deploy <structure> <bits> [knob] on 1|2` takes the first free slot of that parity (without `on`, the next free slot). Each structure answers about its own stream, so one alone cannot answer a challenge about both; a view carries `source` (0 or 1) and `merged`.
- **Merge** (an enchantment, a reward): in a two-enemy fight, structures of a kind that has it, one on each enemy, are paired in slot order (the first on the first enemy with the first on the second, and so on) and each pair answers with `merge`, the structure of both streams, on both views (`merged: true`). A pair that cannot merge (different Space, or different secret seeds) keeps its own answers. It does nothing in a single fight. Valid on Bloom, Count-Min, LogLog, HyperLogLog, K-Minimum Values, MinHash, t-digest, KLL and Quotient (the spec's list); `merge` was added to MinHash (the smaller minimum in every slot, exactly the MinHash of both streams), KLL (levels together, then compacted) and t-digest (centroids together, merged by the scale function); the others had it. Tested: the merged weights are exact and the merged quantiles are within the calibrated rank error of the union's.
- **Theta Sketch** (`thetaSketch`, alias `theta`; fusion of two K-Minimum Values; Count): K-Minimum Values inside, with theta (the largest kept hash as a share of the range) shown, and it **merges by itself** (no enchantment) when one watches each enemy. The spec also gives it intersections; no challenge asks for one, so only unions are built.
- **Where they appear.** `TWIN_CHANCE` (Minion 0, Elite 0.1, Boss 0.25): a drawn extra float at the end of the enemy's design (so existing enemies keep their traits), a second stream of `TWIN_SIZE_SHARE` (0.5) of the tier's size, drawn like a Minion's with the first enemy's Variety (so the union stays small enough for Likeness) and no Likeness or Cunning of its own. The Cunning enemy is the first enemy only: it crafts events into its own stream and aims at the structures that watch it (tested: nothing is crafted against a structure on a second-enemy slot).
- **Interfaces.** The status screen says two enemies share the fight and which enemy each structure watches; the story tells of the second enemy and its traits; the query screen labels each answer `(enemy 2)` or `(merged)`. The learning environment's observation has a twin flag and, per slot, which enemy it watches (0.25, 0.5) or that it is merged (1) (the layout grew again). The bots deploy a wanted kind on both enemies (a pair of slots, Space shared; as many kinds as there are pairs of slots), add the two Frequency answers (counts add) and Count answers (an overcount of the shared values), take a merged answer as it is, and unite what a kind flags on either enemy.
- **The attack's last blow.** Found by the learning-environment test once random play reached it: the event of the enemy's attack that took the last Certainty reported the whole attack, while the fight's reward counted only what was left. `enemyAttacked.damage` is now what was actually taken.
- **Mutation checks** (14): 10 caught; the others got tests (the union is used for the challenge: a Rank armor for both streams; the union's ghosts; a second pair merging) or are equivalent-ish (the Cunning enemy's heaviest value taken from the union rather than the first stream before its burst only picks which value its Count-Min attack aims at).

**Phase 2 balance, final pass (decided 2026-10-19, M9).** Whole runs, 300 seeds (1 to 300), Greedy / Prober / Cautious, Oracle 100 throughout. The order is the order the content went in; each line is the first measurement after that step.

| Step | Greedy | Prober | Cautious |
| --- | --- | --- | --- |
| Start of M9 (MVP, Frequency structures, Cuckoo, KMV) | 43.7 | 26.3 | 9.3 |
| + Rank enemies (weight 0.2) | 37.3 | 21.3 | 8.7 |
| + Likeness (trait hints 0.5 and 1) | 35.7 | 26.7 | - |
| + Cunning, Seeded offered | 37.0 | 24.0 | - |
| + the Bloom, Dyadic, Quotient, SimHash and Likeness fusions in the reward pool | 33.7 | 24.0 | - |
| + two-enemy fights at 0.25 / 0.5 for Elite / Boss | 25.0 | 19.7 | - |
| two-enemy fights off, for comparison | 39.7 | 25.7 | 12.3 |
| **two-enemy fights at 0.1 / 0.25** | 33.3 | 22.7 | 9.0 |
| **+ `LATER_STRUCTURE_SHARE` 0.2 (final)** | **30.7** | **23.0** | **10.7** |

- **Two-enemy fights were the biggest single cost** at the first setting (about 15 points of Greedy) because a pair of structures halves each structure's Space, a kind must be deployed twice, and the sums the bots make overcount; the chance was cut to 0.1 and 0.25. A player who merges, or uses Theta Sketches, does better than the bots.
- **`LATER_STRUCTURE_SHARE` (0.2)**: a structure of a later phase is a fifth as likely to be offered as an MVP one. With twenty-odd structures in the pool, the six MVP structures that the bots live on were crowded out of the three-choice offers; this restores them. Win rates did not move (31.0 at 0.35, 30.7 at 0.2, 31.3 at 0.12); what moved is how often the MVP structures show up in wins.
- **Spec targets, 300 runs, final:** Random under 5 percent met (0.0); Oracle over 95 met (100); no opener over 40 percent of the Greedy family's wins met (largest bloomFilter 36.8); **missed, as since M4:** Greedy wins 55 to 70 percent (30.7; the Frequency gap, Rank, Likeness, Cunning and two enemies each cost it points that a better player recovers), Greedy's wrong strikes 10 to 30 percent (39), and every MVP structure in at least 15 percent of the Greedy family's wins (LogLog 13.5 percent; the rest above). The weakest point of the game for the bots is that they never attach the right structure for a new enemy kind by reading the enemy's description.
- **Decision for M10 / later:** the Greedy gap to the spec's 55 to 70 percent is not closed by tuning numbers; it needs either a smarter baseline bot (reading a Cunning, Rank or two-enemy description) or a different starting kit. Left as a documented deviation.

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

**Enchantments, step 3a (decided 2026-10-17).** The spec says an enchantment is "attached to one structure slot", but nothing is deployed at a rest stop, so an enchantment is attached to an **owned structure** (one of each kind is owned) and applies whenever that structure is deployed in a later fight. The action is `{ type: "enchant"; enchantmentId: string; kind: StructureKind }`, replacing the `slot` in the sketch above.

- **Getting them:** enchantments are rewards (`enchantment:<id>`, weight `REWARD_WEIGHTS.enchantment`) and go into the run's pack unattached. The same one can be taken twice. `enchantments.json` holds, for each, its name, phase, summary, the structures it fits, the variant name it turns a structure into (if any) and whether it can be offered as a reward at all (`reward`); `buildRunConfig` offers only those marked as rewards.
- **Attaching:** at a rest stop only. `enchant` attaches a held enchantment to an owned structure it fits and is not already on. A structure holds **one** at a time: attaching another sends the first back to the pack. An attached enchantment can be **moved** by attaching it to another structure (the rest stop's "move enchantments between structures"). Fusing returns the inputs' enchantments to the pack, and the result starts without one. Attaching does not end the rest stop.
- **In a fight:** the fight config carries the enchantment of each owned kind (`FightConfig.enchantments`). The structure's snapshot records it (`enchantment`), so it survives JSON, and the player sees it in the structure's name (the variant's name if it transforms the structure, otherwise the structure's own name followed by the enchantment in brackets).
- **Seeded** gives a structure a hash seed of its own for the fight: drawn from the structure's own random stream (a named sub-stream, so it never shifts a sampler's choices), different for each deployment, the same on replay. Its only purpose is to defeat an enemy that searches for collisions against the public seed (the Cunning trait, built in M9 step 5), so since then Seeded **is offered as a reward**.
- **Merge** is built with the multi-enemy fights (M9 step 9, below).
- **Steady (step 3b, decided 2026-10-17)** is offered as a reward and turns Count-Min into **Count-Min with Conservative Update** and LogLog into **SuperLogLog**, each a real variant. It fits only those two. Both are built from `Space / (1 + STEADY_SPACE_COST)` (cost 0.10), so the same Space buys a slightly smaller grid; the structure reports the Space it occupies, never more than it was given.
  - **Conservative Update.** An insert raises only the counters that sit at the value's current minimum (to that minimum plus one). The estimate is still the minimum and still never underestimates; it overshoots far less. Measured on the game's streams (60 streams of about 1,500 events, depth 4, mean overshoot of the most frequent value, plain against conservative): width 32, flat stream 39.5 against 18.5; width 32, skewed 34.8 against 0.3; width 64, skewed 15.4 against 0.0; width 128, flat 7.9 against 2.6. The price is that raising only some counters cannot be undone, so **deletes are counted and left in the counters**: the estimate stays an upper bound on the live count, the high bound is the estimate, and the low bound is `max(0, estimate - (e / width) x inserts - deletes)`. The error band uses all the inserts seen, not the live total. The tests require that it never underestimates, that the overshoot bound holds for at least `1 - e^-d` of the values, that it is no worse than the plain sketch for any value on the same grid, and that it cuts the overshoot of the heaviest value by at least 30 percent.
  - **SuperLogLog.** The estimate averages only the smallest 70 percent of the registers (`kept = floor(0.7 m)`): `1.10 x kept x 2^(mean of those registers)`. The constant is calibrated by simulation (the published asymptotic value is about 1.105; at the register counts tested it runs 1.09 to 1.13). The declared standard error is `SUPERLOGLOG_ERROR_COEFFICIENT` (1.05) / sqrt(m), against LogLog's 1.30; measured, plain LogLog gives 1.29 to 1.31 and SuperLogLog 1.09 to 1.12, and the tests allow 1.10 times the declared figure. It keeps LogLog's weaknesses (biased on streams not much larger than its registers, blind to deletes) and handles deletes the same way. Registers merge by maximum.
  - **What it does for the game.** Greedy's Frequency fights with a Count-Min in the kit (150 seeds): Minion 91 to 99 percent, Elite 77 to 77, Boss 84 to 85. So the Frequency gap above is only partly overshoot: on flat streams the true counts are tiny and even a conservative sketch overshoots them. Whole runs (300): Greedy 46.7 percent (47.7 before Steady joined the reward pool), and 86 percent of its won runs attach an enchantment.
- **Fading (step 3c, decided 2026-10-17)** is offered as a reward and turns a Bloom Filter into a **Stable Bloom Filter** (Deng and Rafiei). It fits only the Bloom Filter: on Count-Min, decaying counters would make the estimate fall below the true count, breaking the sketch's one guarantee and the Frequency damage rules, so that half of the spec's "Bloom, Count-Min" is not built.
  - **Structure.** A cell is a 3-bit counter (`FADING_CELL_BITS`), so the same Space buys a third as many cells, `floor(Space / 3)`. Hash count `k` is the Bloom optimum for the cells and the expected-items knob. An insert first decrements `P` pseudo-random cells (positions from a hash of the insert number, so the decay is a function of the state and replays exactly), then sets the value's `k` cells to the maximum (7). `P = 1 / ((Z^(-1/7) - 1)(1/k - 1/cells))` with `Z = e^(-k n / cells)`, which makes the filter settle to the fullness of an ordinary Bloom Filter loaded with `n` values. Deletes are counted and not acted on (a deleted value fades like any other).
  - **Error behavior.** It has **false negatives**: a value is flagged only while all `k` cells are above zero, so it is forgotten once any one has decayed. The chance a value inserted `t` inserts ago is gone is at most `1 - (1 - p)^k`, where `p` is the chance a cell has lost 7 counts, `P(Binomial(t P, 1 / cells) >= 7)`; other values resetting the cell only help it survive. (A first version of the bound had `p^k`, "all cells gone"; the statistical test caught it.) Measured, for 1,000 cells, `k = 7`, `n = 100`: the filter is never wrong about a value just inserted, forgets about 1 percent at age 25, 25 percent at 50, 90 percent at 100 and 99 percent at 200 inserts, always below the bound; and after 2,000 inserts it keeps its zero share at the design value (0.50) and its false-positive rate at the design rate, where a plain Bloom Filter in the same bits flags more than 90 percent of fresh values.
  - **Presence range.** `estimate` is the flagged targets; `low = flagged - false positives - ghosts` as for a Bloom Filter; `high = min(targets, flagged + forgotten)`, where `forgotten` is a binomial upper bound with the chance above, taken at the insert count (the age of the oldest value). The chance of a miss is shared by the two sides, each at 97.5 percent. It is exactly `flagged` while very little has been inserted, and widens as values can have faded.
  - **Default window (tuned 2026-10-17).** With no knob it remembers `FADING_WINDOW` (1.5) times as many values as it has cells; the first default, a tenth of the cells, forgot nearly everything (Greedy's Elite Presence fights won 0 to 14 percent against 100 for a plain Bloom Filter, because Presence targets are drawn from all the live values, old ones included). Scored as the game scores Presence (+5 per real target flagged, -4 per decoy flagged; 120 streams, 4,096 bits, plain Bloom Filter against Fading with a window of 0.5, 1, 1.5, 2 and 3 times the cell count): on Elite and Boss sized streams Fading with 1.5 to 2 times beats the plain filter by about 10 to 25 percent (calm 800 per turn: plain 6.6, 1.5x 7.4; High Growth: 4.5 and 5.7; High Growth with High Churn: 5.7 and 7.3), because the plain filter is saturated and flags every decoy; on Minion sized streams it loses (calm 200 per turn: plain 24.2, 1.5x 17.7), where nothing saturates and the plain filter has three times the cells. Presence fights are so forgiving (striking everything flagged still wins) that this shows as score and Certainty, not as a win rate. A player can still set the window with the knob.
- **Light (step 3d, decided 2026-10-17)** narrows the cells instead of adding a cost, so the same Space buys more of them but they can fill up. It is offered as a reward and fits **Count-Min and HyperLogLog**. The spec also lists LogLog, and a "-25% Space" that cannot be built from whole bits (a 5-bit register times 0.75 is 3.75 bits); both are departures. LogLog is left out because it needs about 30 values per register to be accurate, while a 3-bit register stops at about 16, so Light would only make it worse. `LIGHT_COUNTER_BITS` is 8 and `LIGHT_REGISTER_BITS` is 3.
  - **Count-Min Light.** 8-bit counters: four times the columns from the same Space (8,192 bits, depth 4: 256 columns against 64). A counter stops at 255 and is then left alone (a deleted unit cannot be taken back out of it, since it may hold more than 255). An estimate that reaches 255 only says "at least 255": its upper bound is infinite. Below that it behaves like the plain sketch and never underestimates. Measured on 1,500 events over 600 values (4,096 bits, depth 4), its overshoot of the heaviest value is under 40 percent of the plain sketch's.
  - **HyperLogLog Light.** 3-bit registers (rank at most 7): 512 registers from 1,536 bits against 256, so the predicted error falls by a factor of 1.4. Stopping a register can only make the harmonic sum S too large, so the estimate is a floor and the true sum is at least `S - stopped x 2^-7`; the upper bound is the ordinary one times `S / (S - stopped x 2^-7)`, infinite when every register has stopped. Counting empty registers (small streams) is unaffected.
  - **What it does for the game.** Greedy's Frequency fights with Count-Min in the kit (150 seeds): plain Minion 91, Elite 77, Boss 84 percent; Steady 99, 77, 85; **Light 100, 50, 7**. Light helps on small streams and collapses on big ones, where true counts pass 255 and Greedy strikes at the stopped estimate. That is the intended trade-off, and a player who reads "no upper limit" and strikes higher can use it; the bots take Steady instead.

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

- An enemy picks its non-Low traits at random from the five the stream generator implements (Variety, Skew, Churn, Growth, Drift). Each is High with the tier's `highChance` and Medium otherwise. Likeness and Cunning joined the pool in M9.
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

**Replays, Milestone 5 (decided 2026-10-17).** The spec left these open:

- **The record.** `Replay.actions` are run actions (`RunAction`: the fight actions plus `chooseReward`, `fuse`, `enchant`, `leaveRest`). The config is stored in the replay, so a replay verifies whatever the balance numbers are today; only a change to a *rule* in the engine can break one. A replay is plain JSON of 5 to 8 KB.
- **Recording.** `RunRecorder` plays a run and keeps the actions; it does not keep an action the run refuses, and it will not make a replay of a run that has not finished (no result to claim). The sim records a bot's run (`recordReplay`), and the terminal game records a human's (`pnpm cli --run --record <file>`, written when the run ends; a run that was left has no replay).
- **Verifying.** `verifyReplay(replay, { contentHash? })` never throws. It re-plays the run and answers `ok` with the result, or rejects with a reason: `malformed` (not a replay, or a config that cannot start a run), `version` (recorded under another `ENGINE_VERSION`), `content` (only if the caller asks for a content hash and it differs), `illegal` (an action the run refuses, with its position, which includes any action after the run has ended), `incomplete` (the actions stop before the run ends), `mismatch` (the claimed win, turns or Certainty left is not what the run gives). Changing the seed, the config, an action or the claim is caught.
- **Versions.** `ENGINE_VERSION` is "1". It is bumped by hand on any change to a rule; an old replay then reports `version` instead of looking forged, and verifies only with the engine that recorded it.
- **Content hash.** `contentHash()` is 64 bits (two Murmur3 passes) of the canonical JSON of the files that set the rules: `balance.json`, `traits.json`, `fusions.json`, `enchantments.json` and `upgrades.json`. The text of structures and narration is left out so rewording a help line does not stale a replay. It identifies the content; it is not a security measure. The engine cannot compute it, so the caller passes the one it wants.
- **Speedrun metric.** Only won runs rank: fewer total turns first, then more Certainty left; runs that tie keep the order they were given in (`compareSpeedruns`, `rankSpeedruns`). A ranking of replays that share one seed is the Fixed Seed category; otherwise it is Random Seed.
- **Tools.** `pnpm sim replay record --bot <name> --seed <text> --out <file>`, `replay verify <file...>` (exit code 1 if any is rejected; a note when the content has changed since the recording) and `replay rank <file...>` (verifies, ranks the wins, lists what was left out and why).
- **The regression folder.** `replays/` holds five recorded runs (Oracle, Greedy and Prober wins; Cautious and Random losses), and a test requires every one to verify. If it fails, a rule has changed: bump `ENGINE_VERSION` and re-record the folder with `sim replay record`; do not edit the files.

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

**What was built (decided 2026-10-18, M8).** The environment learns the whole run (not one fight): the reward choices, rest-stop fusions and enchantments are actions too.
- **Packages.** `packages/env-server` (TypeScript): `buildLayout` fixes the action table and observation length from a run config's vocabulary (so every seed of the same content has the same shape), `encodeObservation`, `actionMask` and `decodeAction`, `shapeReward`, `Env` (one game), `Batch` and `handleLine` (the protocol), and `pnpm env-server` (the stdin and stdout loop). `rl/` (Python): `pda_env.client.EnvServer` (standard library only), `PdaEnv` (Gymnasium, with `action_masks()`), `PdaVecEnv` (a Stable-Baselines3 vector environment that talks to the server once per step for all games and restarts ended games on fresh training seeds), `evaluate` (plays held-out seeds in one batch) and `train` (MaskablePPO). `rl/requirements.txt` lists the Python packages; the virtual environment goes in `rl/.venv` (not committed).
- **Protocol additions.** `{"cmd":"info"}` returns `obsSize`, `nActions` and a readable `labels` list. `reset` takes optional `indices` to restart only some games. Replies add `truncated`, `won`, `turns` and `certaintyLeft` to the spec's `obs`, `masks`, `rewards` and `dones`. A game that has ended or been cut off ignores its action and repeats its last reply, with reward 0, until it is reset, so a batch can run until every game is over. `{"cmd":"replay","index":i}` returns a game that ended in a win or a loss as a replay (see Replays) that `pnpm sim replay verify` accepts. A bad request returns `{"error": "..."}` and the server keeps going.
- **Actions (218 at 6 slots).** `end deploy`; `remove` for each slot; `deploy` for each structure kind, slot and Space share (25, 50, 75 and 100 percent of the free Space, rounded down); strikes by meaning: for Presence `flaggedAll` (every target any structure flagged), `confirmed` (flagged by two or more), `none`, and `flaggedBy` each slot; for Frequency and Count `estimate`, `high` and `low` of each slot's answer, and `force1` (a bare force of 1); `choose` each reward on offer; `fuse` each recipe; `enchant` each valid enchantment and structure pair; `leave`. The mask turns an index on only if it decodes to an action the engine lists as legal (strikes: if the meaning applies right now). Slots past `RL_MAX_SLOTS` (6) are not addressable. Presence strikes use target positions, as the engine does, not target values.
- **Observation (187 numbers, all between 0 and 1).** Built only from `observeRun`: phase, Certainty, place in the act, tier, structures owned and enchanted, upgrade counts, enchantments held, and in a fight the turn, enemy HP, Space and slots, the five trait levels, the weak point, the challenge, and for each slot what is deployed, its share of the Space and its latest answer and bounds (large counts squashed with log(1 + x)); the rewards on offer; the fusions and enchantments available. The true answers are never in it.
- **Reward.** Read off the events of each step with weights from `balance.json` (`RL_REWARD`: enemy defeated +1, each turn -0.01, each point of Certainty lost -0.005, run loss -1), so the weights live in the config file and the game's rules do not change. The engine's own per-step reward charges the run loss only when Certainty reaches zero; a fight lost to the turn limit also ends the run, so the environment charges it then too. Tests check every step against the engine's reward and allow exactly that difference.
- **Limits.** `RL_MAX_STEPS` (400, about four times the longest recorded run of 105 actions) cuts an episode off, so an agent that never ends a turn cannot run forever (reported as `truncated`). A cut-off is charged the run-loss weight and treated as the end of a failed run: with it free, the first trained agent learned to stall (mean episode length 1,440 of 1,500) instead of risking a loss. `RL_*` settings are left out of the content hash, like `EXPORT_*`.
- **Held-out seeds.** Evaluation uses the numeric seeds 100000 and up, the same as `pnpm sim runs --seed-base 100000`, so the agent and the bots play the same runs; training seeds are named `train-N`, which are never numbers.

**Result (2026-10-18): the acceptance bar is met.** MaskablePPO (`python -m pda_env.train --steps 4000000 --envs 16`, about 20 minutes on a laptop CPU; default network, learning rate falling from 3e-4 to 5e-5, target KL 0.02) trained on seeds named `train-N` and evaluated on 200 held-out runs each of two seed sets, against the Greedy bot on the same seeds:

| Seeds | Agent wins | Greedy wins | Random wins |
| --- | --- | --- | --- |
| 100000 to 100199 | 186 (93.0 percent) | 108 (54.0 percent) | 1 |
| 500000 to 500199 | 186 (93.0 percent) | 97 (48.5 percent) | not measured |

Of the 200 games in each set the agent lost none or two; the rest (12 and 14) were cut off at the 400-step limit, which counts as a failure. Mean turns when it wins: about 23. Every finished game was saved as a replay (`--save-replays <folder>`, from the `replay` command of the server) and all 374 verify with `pnpm sim replay verify`, so the wins are the engine's own, not the environment's. The agent plays the whole run, including rewards and rest stops. Caveats: one training run, two seed sets of 200 (a 95 percent interval is about plus or minus 3.5 points); the agent is not yet measured on speed against the best human or the Oracle; it wins far more often than Greedy, which says Greedy is a weak player rather than that the game is easy (the Oracle wins all). The trained model is not committed (`rl/models/`, 600 KB).

**Retrained on the final game (2026-10-19, M10).** The M8 agent no longer fit (the learning environment now has 594 actions and 372 observation numbers, and the game has Phase 2 structures, Cunning, Likeness and two-enemy fights), so it was trained again with the same settings (`--steps 4000000 --envs 16`, about 70 minutes of CPU time, since the engine is heavier). Mean training reward rose from 0.4 to about 5 and levelled off near 2 million steps. On 200 held-out runs per set, with Greedy on the same seeds:

| Seeds | Agent wins | Greedy wins | Random wins |
| --- | --- | --- | --- |
| 100000 to 100199 | 152 (76.0 percent) | 58 (29.0 percent) | 0 |
| 500000 to 500199 | 159 (79.5 percent) | 54 (27.0 percent) | not measured |

All 400 saved games verify with `pnpm sim replay verify`. Mean turns when it wins: about 24. The agent wins about 2.7 times as often as Greedy, so the acceptance bar (beats Greedy on held-out seeds) is met again. The game is harder for the agent than before (93 to 76 percent), as it is for Greedy (54 to 29), and the Oracle still wins every run. One training run and two sets of 200 (a 95 percent interval is about plus or minus 6 points at these rates); the model is not committed.

**Training lessons (recorded because each cost a run).**
- *Stalling.* With a free cut-off, the first agents learned to stall (mean episode length 1,440 of 1,500) instead of risking a loss. A cut-off is now charged the run-loss weight and ends the episode as a failure, and the limit is 400.
- *"NaN" crashes.* Four runs ended with `Expected parameter probs ... Simplex()`. Nothing was NaN: with over a hundred legal actions the float32 probabilities occasionally sum to 1 by more than 1e-6, which PyTorch's default check rejects. `train.py` turns the check off (sampling and log-probabilities use normalized logits). Tools kept in `train.py` from the hunt: `GuardCallback` (checks weights and the rollout buffer after every rollout), `SafePPO` (zeroes a non-finite gradient instead of stepping), `explain` (reports what the policy was given when a rollout fails), checkpoints every 250,000 steps, `--resume` and `--detect-anomaly`.
- *Speed.* Building the mask once per state instead of once per action made the server 5.4 times faster.

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

**Sizing (decided 2026-10-18, M7 stage 1).** `packages/exporter/src/sizing.ts` has one pure function per structure. Each takes the workload (any field blank) and returns parameters, the error they give, the memory and `meetsTarget`: with a target error the memory is solved for; with a memory budget the error is; with both the memory is used and `meetsTarget` says whether the error was reached; with neither the default target `EXPORT_DEFAULT_ERROR` (1 percent, in `balance.json`) is used.
- Bloom Filter: m = -n ln p / (ln 2)^2 bits and k = round(m / n x ln 2) hashes, then grown a bit at a time until the real rate with the whole-number k is at or under the target (the formula alone can land a hair above it).
- Count-Min: width = e / error, depth = ceil(ln(1 / (1 - CONFIDENCE))) (3 at 95 percent); the error is a share of the items, so the overshoot in counts is that share times the item count.
- HyperLogLog and LogLog: the register count is the power of two with (coefficient / error)^2 or more registers (or the largest that fits the budget); error is the coefficient over the square root of the registers.
- Linear Counting: the smallest bit array whose standard error sqrt(m (e^t - t - 1)) / n, t = n / m, is within the target, by binary search (and a refusal, not a loop, if no size up to 2^50 bits reaches it).
- Reservoir Sampling: sample size z^2 x 0.25 / error^2 for a proportion at the confidence; Exact Memory: every distinct value and its counter.
- Two tests: one for the formulas and modes, and a statistical test per bound (300 seeded trials): a Bloom Filter sized for 1 percent flags decoys at no more than 1.3 times that rate, and a HyperLogLog sized for 2 percent is within 1.96 standard errors in at least the stated share of streams, both on the engine's own structures.

**Templates and toolkit tests (decided 2026-10-18, M7 stage 3).** `packages/exporter/templates/typescript` and `.../python` hold real, runnable source: `src/hash`, one file per structure, `sizing` and `tests/`, plus `registers` (shared by LogLog and HyperLogLog). `generateToolkit(language, owned, templates)` only chooses which of those files a player's toolkit contains (a structure's source and tests, and what it needs); it writes no code of its own. `pnpm export generate <typescript|python> <dir>` writes one, `pnpm export vectors` rewrites the shared known answers, and `pnpm export check` generates both toolkits in a temporary folder and runs them.
- **Same answers in both languages.** `templates/shared/vectors.json` is produced by the game's own structures and the exporter's own sizing (hash values with two seeds for integers and strings, double-hash positions, a Bloom Filter's fill and probes, Count-Min estimates, HyperLogLog, LogLog and Linear Counting estimates, and sizing inputs and outputs). It is copied into every toolkit as `tests/vectors.json`, and both languages' tests must reproduce it. A unit test in the repo fails if the committed file stops matching the engine.
- **Toolchains.** TypeScript: no dependencies; Node 22.18 or later runs the `.ts` files directly (type stripping) and its built-in test runner (`node --test "tests/*.test.ts"`); `pnpm export check` also type-checks the generated TypeScript under `--strict`. Python: 3.9 or later, standard library only, tests in pytest. The CI job `toolkits` runs `pnpm export check` on Python 3.9 and 3.13.
- **API.** Items are integers from 0 to 2^32 - 1 (hashed as four little-endian bytes, the same as the game), strings (UTF-8) or bytes; every structure takes a seed (default the game's public one, with a note to pass a secret one against adversarial input). Reservoir Sampling takes the random source as an argument so runs repeat. HyperLogLog uses the game's rule (count empty registers while that estimate is under 2.8 times the register count). Register structures are sized to at least 16 registers. Python rounds half up when it chooses the Bloom hash count, to match the other languages.
- **Tests per toolkit** (47 in each language once M10 covered every structure; 17 at M7): one per topic for each structure, one known-answer test per structure and a statistical test for Bloom (at most 1.3 times the sized rate), Count-Min (never under, overshoot band at e^-depth), HyperLogLog, LogLog, Linear Counting (within 1.96 standard errors in at least the stated share of 200 seeded streams) and Reservoir (a share within the sized error).
- **Every structure has a toolkit (decided 2026-10-19, M10).** All 22 kinds have a TypeScript and a Python template with sizing, known answers from the game's own structures and tests (one known-answer test and one statistical test each; Python trial counts are reduced to keep its suite near 90 seconds). The per-structure facts (class, file names, helpers it needs, arguments, guide text, sizing, formula) live in `packages/exporter/src/catalog.ts`; the toolkit, reports and analysis read it. A structure's `needs` lists the template files it builds on (Scalable Bloom needs Bloom, Dyadic Count-Min and Top-K need Count-Min, LSH needs MinHash, Theta needs K-Minimum Values). Conventions: `add`, `remove` where the structure allows it, `estimate` or `mightContain`, `merge` where the game has one. Each template was mutation-checked: a changed formula or constant fails at least one test (two equivalent mutants noted: LSH row search starting at 2, and the Theta intersection's strict bound at theta).

**Reports, profile and zip (decided 2026-10-18, M7 stage 2 and 4).** `buildToolkit({ language, replay, workload, templates, constants })` replays a verified run (`analyzeRun`) and returns the whole toolkit as path to text: the templates' files for every structure the player **used** (owned at the end, consumed by a fusion, or deployed in any fight, so Linear Counting and LogLog appear after fusing into HyperLogLog) plus the three documents. `toolkitZip` packs it under `toolkit/` with JSZip, with a fixed timestamp so the same toolkit always makes the same bytes. `pnpm export toolkit <language> <replay.json> <out.zip> [--items N] [--distinct N] [--error E] [--memory BITS]` verifies the replay (including its content hash) and writes the zip. The browser screen (below) calls the same code.
- **Tradeoff profile (decided).** For each structure the player deployed: the number of deploys, the mean Space, and the **Space ratio**, which is the Space they gave divided by the Space production-grade sizing needs for that enemy's stream at the default target (`EXPORT_DEFAULT_ERROR`, 1 percent; the stream size stands in for both the item count and the distinct count). Below 1 means they ran the structure tighter than production would and accepted more error; above 1, roomier. It is the "ratio relative to theoretical optimum" the spec asks for, using Space because the player's other choices (knobs) are derived by the engine and cannot be compared without the true stream. SIZING.md shows it next to each structure with what that style would cost on the real workload; it does not change the parameters, which come from the workload alone (a departure from "computed from the workload and the profile": a profile that moved the parameters would make the sizing depend on how the player happened to play).
- **SIZING.md** lists the workload as given; says which blanks were filled (distinct from items or items from distinct, the default error when neither error nor memory was given); and for each structure gives the size, the error it gives, a constructor call in the chosen language and the formula, or says what it needs ("Needs the item count") instead of guessing. With a memory budget each structure uses it and reports the error that gives.
- **FIELD_REPORT.md** has the result, a table by structure (fights deployed in, fights won, mean Space, Space ratio), the enemies met with their traits above Low and the structures deployed, strike soundness by question, and the mistakes (up to 12): a Frequency strike that was blocked or landed with more than double the true count, a Count estimate too far to hurt, a Presence strike that hit decoys. Leaving real Presence targets unstruck is shown in the strike text but is not a mistake.
- **README.md** says, for each structure used, what it answers, when to use it and when not to, where its code is, and how to run the tests.
- **Export screen (decided 2026-10-18).** When a run ends (won or lost), the page offers "Export toolkit" next to "Download replay": a form with the language (TypeScript or Python), the item count, the number of different items, the acceptable error as a percentage and the memory budget in KiB. Blank fields are not given; commas and spaces are accepted; anything that is not a positive number, an error of 100 percent or more, or more different items than items is refused with a message. "Build zip" runs `buildToolkit` and `toolkitZip` in the page (no server) and downloads `toolkit-<language>-<seed>.zip`. The web build reads every template file as text with Vite's `import.meta.glob`, so the page carries the templates (the production bundle is about 380 KB, 112 KB gzipped). Starting a new run closes and clears the form.
- Exporter settings (`EXPORT_*` in `balance.json`) are left out of the content hash, so changing them does not invalidate recorded runs.

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
| choose \<number> | choose 2 | chooseReward (a reward is on offer; `take` and `pick` also work, and so does a bare number) |
| fuse \[name] | fuse hll | fuse (at a rest stop; the name is the recipe id or the result's name or alias, and may be left out when only one fusion is available) |
| enchant \<enchantment> \[structure] | enchant seeded bloom | enchant (at a rest stop; the structure may be left out when the enchantment fits only one) |
| leave | leave | leaveRest (also `ready`, `go`, `done`, `continue`) |

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
- **Run mode (decided 2026-10-17).** `pnpm cli --run [--seed <text>]` plays a whole act on the content `buildRunConfig` designs from the seed (`--tier` and `--loadout` are refused, since a run chooses its own enemies and structures; the default stays a single fight). A `RunSession` has the same interface as the fight `Session`, so the same play loop runs it. Each fight starts with "Fight n of N." and the enemy described. Winning a fight shows the rewards numbered from 1, each with its name, whether it is a new structure or an upgrade, and what it does; `choose <number>` takes one (anything else except `status`, `help` and `quit` is refused until one is taken). The rest stop lists the fusions that can be done, with their inputs and result, or says there is nothing to fuse; `fuse` does one and `leave` goes on. The prompt shows the fight, the turn, the phase, the Certainty against its maximum and the free Space (`[fight 2/7 turn 3 strike | Certainty 120/150 | Enemy HP 12 | 8192 bits free] >`, `[reward after fight 2/7 | ...] >`, `[rest stop | ...] >`). `status` shows the place in the act, the Certainty against its maximum, the structures owned and the upgrades taken, then the fight's own status. The parser and narrator for these (`parseRunCommand`, `narrateRunStep`, `renderRewards`, `renderRest`, `renderRunStatus`) are in `ui-core`, shared with the web UI.
- **Strike feedback (decided 2026-10-14).** After a strike the game says what was true, so the player can learn how far off a range was: a Frequency strike reports the true count and the force used, a Count strike the true number of distinct values and the estimate used, a Presence strike how many of the targets were real. The truth is part of the `strikeResolved` event (`trueCount` and `force`, `trueDistinct` and `estimate`, `realTotal`); it appears only after the strike, never in an Observation. The first playtest found that without it a player cannot tell a good range from a bad one.
- `help` lists only the structures in the loadout; asking about another one still explains it and says it is not owned. On a Presence challenge turn the targets are printed once, in the query screen with the structures' flags.

**Web extras:** a side panel with live visuals of each deployed structure (bit array fill, counter heatmap, register bars), an error-rate readout that updates as the stream grows, and a light/dark theme. Every visual is optional; the game must be fully playable as text.

**Web UI (decided 2026-10-17, M6).** `pnpm dev` serves `packages/web`, a Vite and plain TypeScript page (no framework) that plays a whole run:

- The sessions (`createSession`, `createRunSession`) moved from `cli` to `ui-core`, so the terminal and the page run the same code. A `RunSession` also offers `structures()` (one visual per deployed structure) and `suggestions()` (the commands that make sense now, shown as buttons; typing still works for everything).
- `structureVisual(snapshot, slot, constants)` in `ui-core` is pure and tested: it turns a structure's snapshot into cells between 0 and 1 and a shape. Bloom Filter, Linear Counting, Stable Bloom, Exact Memory and Reservoir are strips (at most 256 cells, averaged down if bigger), Count-Min is a heatmap (a row per hash, a column per counter), LogLog and HyperLogLog are bars (one per register). Each has a caption and a readout in words: fill and false-positive rate, the Count-Min overshoot band over the live count, the register error (plus or minus a share), entries or slots used. The readout is the error-rate display and updates after every command.
- The page: transcript, prompt line, input with arrow-key history, a Structures panel (a side column on wide screens, a fold-out below the text at 720 px or narrower, where it starts closed), a new-run button, `?seed=` in the address to replay a seed (the seed is kept in the address; a fresh run picks a random one), a download button for the replay once a run has ended, and a light/dark theme that follows the system and can be switched (the choice is remembered when storage is allowed). Visuals are hidden from screen readers, since their caption and readout carry the same information.
- `packages/web` has its own tsconfig (with the DOM types); the root one leaves it out and `pnpm lint` checks both. The engine and `ui-core` still use no DOM.

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
| M10 Close the debts | Exporter templates and sizing for every Phase 2 structure, retrained learning agent, a clean first CI run, final docs | Toolkits for every structure pass their own tests in both languages; the agent beats Greedy on held-out seeds; CI green |

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
