import type { GameEvent, RunEvent } from "@pda/engine";

/** How a step is scored. Costs are given as positive numbers and subtracted. */
export interface RewardWeights {
  enemyDefeated: number;
  perTurn: number;
  perCertaintyLost: number;
  runLoss: number;
}

/**
 * Speedrun shaping: a reward for each enemy defeated, a cost for each turn, a cost for each point of Certainty lost, and a
 * larger cost for losing the run. Read off the events of a step, so the weights are the tool's own and the game's rules do not change.
 */
export function shapeReward(events: ReadonlyArray<GameEvent | RunEvent>, weights: RewardWeights): number {
  let reward = 0;
  for (const event of events) {
    switch (event.type) {
      case "enemyAttacked": // the enemy attacks as each turn ends, whether or not another follows
        reward -= weights.perTurn + weights.perCertaintyLost * event.damage;
        break;
      case "strikeResolved":
        reward -= weights.perCertaintyLost * event.certaintyLost;
        break;
      case "fightLost":
        reward -= weights.perCertaintyLost * event.certaintyLost;
        break;
      case "fightWon":
        reward += weights.enemyDefeated;
        break;
      case "runLost":
        reward -= weights.runLoss;
        break;
      default:
        break;
    }
  }
  return reward;
}
