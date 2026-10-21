import { describe, expect, it } from "vitest";
import { eachCase } from "../../engine/src/testCases";
import { buildFightConfig, narration } from "@pda/content";
import { createFight, observe, step, STRUCTURE_KINDS, type Action, type Challenge, type FightConfig, type FightState, type GameEvent } from "@pda/engine";
import { describeEnemy, formatNumber, narrateEvent, narrateEvents, renderTemplate } from "./narrator";
import { parseCommand } from "./parser";
import { renderHelp, renderQuery, renderStatus } from "./views";
import { answer, observation, view } from "./testUtils";

const unresolved = (lines: string[]) => lines.some((line) => /[{}]/.test(line));

describe("renderTemplate", () => {
  it("fills in every variable; throws when a variable is missing, so a bad template cannot reach a player", () => {
    // fills in every variable
    {
      expect(renderTemplate("{a} and {b}, {a} again", { a: 1, b: "two" })).toBe("1 and two, 1 again");
    }
    // throws when a variable is missing, so a bad template cannot reach a player
    {
      expect(() => renderTemplate("{a} and {b}", { a: 1 })).toThrow(/"b"/);
    }
  });
});

describe("formatNumber", () => {
  it("shows whole numbers plainly and trims decimals", () => {
    expect(formatNumber(95)).toBe("95");
    expect(formatNumber(17.1234)).toBe("17.12");
    expect(formatNumber(20)).toBe("20");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(Infinity)).toBe("no limit");
  });
});

describe("narrateEvent", () => {
  it("numbers slots from 1 and names the structure; mentions retractions only when there were some; states a Frequency challenge, and reveals the weak point the first time; and 4 more", () => {
    // numbers slots from 1 and names the structure
    {
      expect(narrateEvent({ type: "structureDeployed", slot: 0, kind: "bloomFilter", spaceBits: 2048 })).toEqual([
        "Bloom Filter takes slot 1 with 2048 bits.",
      ]);
      expect(narrateEvent({ type: "structureRemoved", slot: 2, kind: "logLog", spaceBits: 640 })).toEqual([
        "LogLog is removed from slot 3. 640 bits return to your budget.",
      ]);
    }
    // mentions retractions only when there were some
    {
      expect(narrateEvent({ type: "burstIngested", turn: 1, events: 200, inserts: 200, deletes: 0 })).toEqual([
        "The stream surges: 200 events arrive.",
      ]);
      expect(narrateEvent({ type: "burstIngested", turn: 1, events: 200, inserts: 150, deletes: 50 })).toEqual([
        "The stream surges: 200 events arrive, 50 of them retractions.",
      ]);
    }
    // states a Frequency challenge, and reveals the weak point the first time
    {
      const first = narrateEvent({ type: "challengeIssued", turn: 2, weakPoint: "frequency", challenge: { kind: "frequency", value: 777 }, firstReveal: true });
      expect(first[0]).toBe("You have found its weak point: frequency.");
      expect(first.join(" ")).toMatch(/the value 777/);

      const later = narrateEvent({ type: "challengeIssued", turn: 3, weakPoint: "frequency", challenge: { kind: "frequency", value: 9 }, firstReveal: false });
      expect(later.join(" ")).not.toMatch(/weak point/);
    }
    // lists Presence targets by number, from 1
    {
      const lines = narrateEvent({ type: "challengeIssued", turn: 2, weakPoint: "presence", challenge: { kind: "presence", targets: [11, 22, 33] }, firstReveal: false });
      expect(lines.join("\n")).toMatch(/shows you 3 values/);
      expect(lines.slice(-3)).toEqual(["  1) 11", "  2) 22", "  3) 33"]);
    }
    // describes each strike outcome, and tells the player what was true
    {
      const base = { type: "strikeResolved", turn: 2 } as const;
      expect(narrateEvent({ ...base, kind: "frequency", outcome: "hit", damage: 17.8421, certaintyLost: 0, force: 15, trueCount: 13 })).toEqual([
        "Your strike lands for 17.84 damage. The value had appeared 13 times; you struck with 15.",
      ]);
      expect(narrateEvent({ ...base, kind: "frequency", outcome: "blocked", damage: 0, certaintyLost: 3, force: 9, trueCount: 12 }).join(" ")).toMatch(
        /turns it aside.*lose 3 Certainty.*appeared 12 times; you struck with 9/,
      );
      expect(narrateEvent({ ...base, kind: "count", outcome: "hit", accuracy: 0.5, damage: 10, certaintyLost: 0, estimate: 190, trueDistinct: 200 })).toEqual([
        "Your estimate is close enough to hurt it: 10 damage. There were 200 distinct values; you said 190.",
      ]);
      expect(narrateEvent({ ...base, kind: "count", outcome: "miss", accuracy: -1, damage: 0, certaintyLost: 3, estimate: 50, trueDistinct: 200 }).join(" ")).toMatch(
        /wildly off.*lose 3 Certainty.*200 distinct values; you said 50/,
      );
      expect(narrateEvent({ ...base, kind: "presence", realHits: 3, decoyHits: 1, damage: 15, certaintyLost: 4, realTotal: 5 })).toEqual([
        "You strike 3 real and 1 decoy targets: 15 damage, 4 Certainty lost. 5 of the targets were real.",
      ]);
    }
    // can leave the Presence target list out, for a screen that prints it with the answers
    {
      const event: GameEvent = { type: "challengeIssued", turn: 2, weakPoint: "presence", challenge: { kind: "presence", targets: [11, 22] }, firstReveal: false };
      expect(narrateEvents([event], { listTargets: false }).join("\n")).not.toMatch(/1\) 11/);
      expect(narrateEvents([event], { listTargets: false }).join("\n")).toMatch(/shows you 2 values/);
      expect(narrateEvents([event]).join("\n")).toMatch(/1\) 11/);
    }
    // narrates the enemy's attack, the turn and the ending
    {
      expect(narrateEvent({ type: "enemyAttacked", turn: 2, damage: 3 })).toEqual(["The enemy hits back. You lose 3 Certainty."]);
      expect(narrateEvent({ type: "turnStarted", turn: 3 })).toEqual(["Turn 3."]);
      expect(narrateEvent({ type: "fightWon", turn: 4 })).toEqual(["The enemy collapses. You win on turn 4."]);
      expect(narrateEvent({ type: "fightLost", turn: 8, reason: "turnLimit", certaintyLost: 20 }).join(" ")).toMatch(/overflow costs 20 Certainty/);
      expect(narrateEvent({ type: "fightLost", turn: 3, reason: "certainty", certaintyLost: 0 })).toEqual(["Your Certainty is gone. The run is over."]);
    }
  });
});

describe("describeEnemy", () => {
  const calm = { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low", likeness: "low", cunning: "low" } as const;

  it("introduces the tier and says a plain stream looks plain; describes only the traits above Low, with their level", () => {
    // introduces the tier and says a plain stream looks plain
    {
      expect(describeEnemy({ tier: "minion", traits: calm })).toEqual(["A minion approaches.", narration.enemy.calm]);
    }
    // describes only the traits above Low, with their level
    {
      const lines = describeEnemy({ tier: "boss", traits: { ...calm, skew: "high", churn: "medium" } });
      expect(lines[0]).toBe("A boss looms.");
      expect(lines).toContain("- Skew (high): ruled by a handful of favorites.");
      expect(lines).toContain("- Churn (medium): retracts some of what it sends.");
      expect(lines).toHaveLength(3);
    }
  });
});

describe("renderStatus", () => {
  it("shows resources, the enemy's traits, and each structure with slots numbered from 1; says the weak point is unknown until it is revealed, and shows an empty loadout", () => {
    // shows resources, the enemy's traits, and each structure with slots numbered from 1
    {
      const text = renderStatus(
        observation({
          turn: 3,
          certainty: 91,
          enemyHp: 22.5,
          spaceFree: 4096,
          slotsFree: 2,
          weakPoint: "frequency",
          traits: { variety: "low", skew: "high", churn: "low", growth: "medium", drift: "low", likeness: "low", cunning: "low" },
          structures: [view(0, "countMinSketch", null, 4096)],
        }),
      ).join("\n");
      expect(text).toMatch(/Turn 3/);
      expect(text).toMatch(/Certainty: 91/);
      expect(text).toMatch(/Enemy HP: 22.5/);
      expect(text).toMatch(/4096 bits free/);
      expect(text).toMatch(/Weak point: frequency/);
      expect(text).toMatch(/Skew \(high\)/);
      expect(text).toMatch(/Growth \(medium\)/);
      expect(text).not.toMatch(/Variety/); // Low traits are not listed
      expect(text).toMatch(/1\. Count-Min Sketch \(4096 bits\)/);
    }
    // says the weak point is unknown until it is revealed, and shows an empty loadout
    {
      const text = renderStatus(observation()).join("\n");
      expect(text).toMatch(/Weak point: unknown/);
      expect(text).toMatch(/No structures deployed/);
    }
  });
});

describe("renderQuery", () => {
  it("explains there is nothing to query before a challenge; shows each structure's estimate, range and confidence, or that it cannot answer; marks which Presence targets each structure flagged, and which are confirmed; and 1 more", () => {
    // explains there is nothing to query before a challenge
    {
      expect(renderQuery(observation()).join(" ")).toMatch(/nothing to ask about yet/);
    }
    // shows each structure's estimate, range and confidence, or that it cannot answer
    {
      const text = renderQuery(
        observation({
          phase: "strike",
          challenge: { kind: "frequency", value: 777 },
          structures: [
            view(0, "countMinSketch", answer(95, 66, 95, 0.9817)),
            view(1, "reservoirSampling", answer(90.4, 70.2, 120.5)),
            view(2, "bloomFilter", null),
            view(3, "linearCounting", answer(300, 200, Infinity)),
          ],
        }),
      ).join("\n");
      expect(text).toMatch(/value 777/);
      expect(text).toMatch(/\[1\] Count-Min Sketch: about 95 \(likely between 66 and 95, 98% confidence\)/);
      expect(text).toMatch(/\[2\] Reservoir Sampling: about 90.4 \(likely between 70.2 and 120.5, 95% confidence\)/);
      expect(text).toMatch(/\[3\] Bloom Filter: cannot answer this question/);
      expect(text).toMatch(/\[4\] Linear Counting: about 300 \(at least 200, no upper limit, 95% confidence\)/);
    }
    // marks which Presence targets each structure flagged, and which are confirmed
    {
      const text = renderQuery(
        observation({
          phase: "strike",
          challenge: { kind: "presence", targets: [101, 102, 103] },
          structures: [view(0, "bloomFilter", answer([101, 103], 1, 2)), view(1, "exactMemory", answer([103], 1, 1))],
        }),
      ).join("\n");
      expect(text).toMatch(/1\) 101 +flagged by slot 1\b/);
      expect(text.split("\n").find((line) => line.includes("1) 101"))).not.toMatch(/confirmed/); // only one structure flagged it
      expect(text).not.toMatch(/2\) 102 +flagged/);
      expect(text).toMatch(/3\) 103 +flagged by slots 1, 2 \(confirmed\)/);
      expect(text).toMatch(/\[1\] Bloom Filter: flags 2 targets; between 1 and 2 of the targets are real/);
    }
    // says when no structure is deployed
    {
      const text = renderQuery(observation({ phase: "strike", challenge: { kind: "count" } })).join("\n");
      expect(text).toMatch(/No structures deployed/);
    }
  });
});

describe("Rank in the story and the query screen", () => {
  it("tells the armor's percentile on the challenge, says how a strike ranked against it whether it hit or was blocked, and leaves no template variable unfilled; the query screen asks the question and shows each structure's value and range", () => {
    const challenge = narrateEvent({ type: "challengeIssued", turn: 2, weakPoint: "rank", challenge: { kind: "rank", quantile: 0.9 }, firstReveal: true });
    expect(challenge.join(" ")).toMatch(/rank/i);
    expect(challenge.join(" ")).toMatch(/rank 90 percent/);
    expect(unresolved(challenge)).toBe(false);

    const hit = narrateEvent({ type: "strikeResolved", turn: 2, kind: "rank", outcome: "hit", damage: 12, certaintyLost: 0, force: 4200, rank: 0.93, quantile: 0.9 });
    expect(hit.join(" ")).toMatch(/ranks at 93 percent.*armor at 90 percent/);
    expect(hit.join(" ")).toMatch(/12 damage/);
    const blocked = narrateEvent({ type: "strikeResolved", turn: 2, kind: "rank", outcome: "blocked", damage: 0, certaintyLost: 3, force: 12, rank: 0.4, quantile: 0.9 });
    expect(blocked.join(" ")).toMatch(/ranks at only 40 percent.*below the armor at 90 percent/);
    expect(blocked.join(" ")).toMatch(/lose 3 Certainty/);
    expect(unresolved([...hit, ...blocked])).toBe(false);

    const text = renderQuery(observation({ phase: "strike", challenge: { kind: "rank", quantile: 0.99 }, structures: [view(0, "reservoirSampling", answer(5000, 4000, 6000))] })).join("\n");
    expect(text).toMatch(/rank 99 percent/);
    expect(text).toMatch(/\[1\] Reservoir Sampling:/);
    expect(text).toMatch(/5000/);
  });
});

describe("Likeness in the story and the query screen", () => {
  it("tells the threshold and lists the sets by size, narrates a strike without unfilled variables, and the query screen marks the sets a structure flagged by position", () => {
    const challenge: Challenge = { kind: "likeness", targets: [0, 1, 2], copies: [[1, 2, 3], [4, 5], [6, 7, 8, 9]], threshold: 0.6 };
    const lines = narrateEvent({ type: "challengeIssued", turn: 2, weakPoint: "likeness", challenge, firstReveal: true });
    expect(lines.join("\n")).toMatch(/60 percent/);
    expect(lines.join("\n")).toMatch(/1\) a set of 3 values/);
    expect(lines.join("\n")).toMatch(/3\) a set of 4 values/);
    const strike = narrateEvent({ type: "strikeResolved", turn: 2, kind: "likeness", realHits: 2, decoyHits: 1, damage: 10, certaintyLost: 4, realTotal: 3 });
    expect(strike.join(" ")).toMatch(/2 real and 1 look-alike.*10 damage.*4 Certainty/);
    expect(unresolved([...lines, ...strike])).toBe(false);

    const flagged = { estimate: [0, 2], low: 1, high: 2, confidence: 0.95 };
    const text = renderQuery(observation({ phase: "strike", challenge, structures: [view(0, "minHash", flagged)] })).join("\n");
    expect(text).toMatch(/2\) a set of 2 values\n/);
    expect(text).toMatch(/1\) a set of 3 values +flagged by slot 1/);
    expect(text).toMatch(/3\) a set of 4 values +flagged by slot 1/);
    expect(text).toMatch(/\[1\] MinHash: flags 2 targets/);
  });
});

describe("renderHelp", () => {
  it("lists every command and structure when no topic is given; explains a command; lists only the structures the player owns when given a loadout; and 3 more", () => {
    // lists every command and structure when no topic is given
    {
      const text = renderHelp().join("\n");
      for (const command of Object.values(narration.commands)) expect(text).toContain(command.usage);
      expect(text).toMatch(/bloom/);
      expect(text).toMatch(/Count-Min Sketch/);
    }
    // explains a command
    {
      const text = renderHelp("strike").join("\n");
      expect(text).toContain(narration.commands.strike.usage);
      expect(text).toContain(narration.commands.strike.summary);
    }
    // lists only the structures the player owns when given a loadout
    {
      const text = renderHelp(undefined, ["bloomFilter", "linearCounting"]).join("\n");
      expect(text).toMatch(/bloom: Bloom Filter/);
      expect(text).toMatch(/linear: Linear Counting/);
      expect(text).not.toMatch(/loglog|countmin|reservoir: |exact: /);
      expect(renderHelp().join("\n")).toMatch(/loglog/); // with no loadout, everything is listed
    }
    // still explains a structure the player does not own, and says so
    {
      const text = renderHelp("loglog", ["bloomFilter"]).join("\n");
      expect(text).toMatch(/LogLog/);
      expect(text).toMatch(/do not own/i);
      expect(renderHelp("bloom", ["bloomFilter"]).join("\n")).not.toMatch(/do not own/i);
    }
    // explains a structure, including its knob, by alias or full name
    {
      for (const topic of ["cms", "Count-Min Sketch", "countmin"]) {
        const text = renderHelp(topic).join("\n");
        expect(text).toMatch(/Count-Min Sketch/);
        expect(text).toMatch(/frequency/);
        expect(text).toMatch(/depth/);
        expect(text).toMatch(/1 to 16/);
      }
      expect(renderHelp("exact").join("\n")).not.toMatch(/Knob/);
    }
    // says when it does not know the topic
    {
      expect(renderHelp("skiplist").join(" ")).toMatch(/No help for "skiplist"/);
    }
  });
});

describe("a whole fight from typed commands", () => {
  function playFromText(seed: string, weakPoint: "presence" | "frequency" | "count") {
    const base = buildFightConfig({ seed, tier: "minion", loadout: [...STRUCTURE_KINDS] });
    const config: FightConfig = { ...base, enemy: { ...base.enemy, weakPoints: [weakPoint] } };
    let state: FightState = createFight(seed, config);
    const log: string[] = [...describeEnemy(config.enemy)];
    const events: GameEvent[] = [];
    const typed: string[] = [];

    const type = (line: string): boolean => {
      typed.push(line);
      const parsed = parseCommand(line, { observation: observe(state), loadout: config.loadout });
      if (parsed.kind !== "action") return false;
      const result = step(state, parsed.action as Action);
      state = result.state;
      events.push(...result.events);
      log.push(...narrateEvents(result.events));
      return true;
    };

    type("deploy cms 2048 3");
    type("deploy bloom 2048");
    type("deploy exact 2048");
    for (let i = 0; i < 40 && state.phase !== "won" && state.phase !== "lost"; i++) {
      if (state.phase === "deploy") {
        type("ready");
        continue;
      }
      log.push(...renderQuery(observe(state)));
      const ok = type("strike confirmed") || type("strike high") || type("strike flagged") || type("strike 1");
      expect(ok, `no strike command worked: ${typed.slice(-3).join(" | ")}`).toBe(true);
    }
    return { state, log, events, typed };
  }

  it("plays a fight of each kind through the parser, engine and narrator; narrates every kind of event it produces", () => {
    // plays a fight of each kind through the parser, engine and narrator
    {
      eachCase((["presence", "frequency", "count"] as const).map((weakPoint) => [weakPoint, weakPoint] as const), (weakPoint) => {
        const { state, log, events } = playFromText(`typed-${weakPoint}`, weakPoint);
        expect(state.phase === "won" || state.phase === "lost").toBe(true);
        expect(unresolved(log)).toBe(false);
        expect(log.every((line) => typeof line === "string")).toBe(true);
        expect(events.some((e) => e.type === "challengeIssued")).toBe(true);
        expect(log.join("\n")).toMatch(/Turn 2\./);
        expect(log.join("\n")).toMatch(/weak point/);
      });
    }
    // narrates every kind of event it produces
    {
      const kinds = new Set<string>();
      for (const [i, weakPoint] of (["presence", "frequency", "count"] as const).entries()) {
        for (const e of playFromText(`kinds-${i}`, weakPoint).events) kinds.add(e.type);
      }
      for (const kind of ["structureDeployed", "burstIngested", "challengeIssued", "strikeResolved", "enemyAttacked", "turnStarted"]) {
        expect(kinds.has(kind), kind).toBe(true);
      }
    }
  });
});

describe("two enemies in the story and the status", () => {
  it("tells of the second enemy and says which enemy each structure watches or that it answers for both", () => {
    const calm = { variety: "low", skew: "low", churn: "low", growth: "low", drift: "low", likeness: "low", cunning: "low" } as const;
    const lines = describeEnemy({ tier: "boss", traits: calm, second: { size: 500, traits: { ...calm, skew: "high" } } }).join("\n");
    expect(lines).toMatch(/second enemy fights beside it/i);
    expect(lines).toMatch(/Second enemy, Skew \(high\)/);
    expect(describeEnemy({ tier: "boss", traits: calm }).join("\n")).not.toMatch(/second enemy/i);

    const status = renderStatus(observation({ secondTraits: { ...calm, churn: "medium" }, structures: [{ ...view(0, "bloomFilter"), source: 0 }, { ...view(1, "countMinSketch"), source: 1 }, { ...view(2, "kMinimumValues"), source: 0, merged: true }] })).join("\n");
    expect(status).toMatch(/Two enemies share this fight/);
    expect(status).toMatch(/Second enemy: Churn \(medium\)/);
    expect(status).toMatch(/1\. Bloom Filter \(1024 bits, watching enemy 1\)/);
    expect(status).toMatch(/2\. Count-Min Sketch \(1024 bits, watching enemy 2\)/);
    expect(status).toMatch(/3\. K-Minimum Values \(1024 bits, both enemies merged\)/);
    expect(renderStatus(observation()).join("\n")).not.toMatch(/Two enemies/);
    const query = renderQuery(observation({ phase: "strike", challenge: { kind: "count" }, secondTraits: calm, structures: [{ ...view(0, "kMinimumValues", answer(40, 35, 45)), source: 0, merged: true }, { ...view(1, "logLog", answer(30, 20, 40)), source: 1 }] })).join("\n");
    expect(query).toMatch(/\[1\] K-Minimum Values \(merged\):/);
    expect(query).toMatch(/\[2\] LogLog \(enemy 2\):/);
  });
});
