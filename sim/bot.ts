import type { GameState } from '../src/engine/state'
import type { Decimal } from '../src/engine/decimal'
import { BUILDING_IDS, type BuildingId } from '../src/content/buildings'
import { nextCostAffordable } from '../src/systems/buildings'

/**
 * Bot-player heuristic. The runner consults it once per simulated step so the
 * harness exercises the same purchase code paths a real player drives, and the
 * no-softlock invariant uses it to ask "is any progress action available?".
 */
export interface BotAction {
  /** Discriminator: the only action kind in M1 is building an upgrade. */
  kind: 'build'
  /** Which building to upgrade by one level. */
  id: BuildingId
}

/**
 * Choose the next action for the bot, or null when nothing is affordable.
 *
 * M1.1 strategy: buy the CHEAPEST affordable, non-maxed building, ranking by the
 * total cost across resources (wood + clay + iron) measured on Decimal so the
 * comparison stays exact past 2^53. Ties resolve to the first building in
 * {@link BUILDING_IDS} order, keeping the choice fully deterministic (required by
 * the determinism / save-load invariants). Greedy "cheapest first" keeps the bot
 * spending continuously, which is what drives the economy forward in the harness.
 *
 * Returns null when every non-maxed building is unaffordable — the signal the
 * no-softlock check pairs with resource growth to decide whether the run stalled.
 */
export function chooseAction(state: GameState): BotAction | null {
  let best: BuildingId | null = null
  let bestSum: Decimal | null = null

  for (const id of BUILDING_IDS) {
    const { cost, affordable, maxed } = nextCostAffordable(state, id)
    if (maxed || !affordable) continue
    const sum = cost.wood.add(cost.clay).add(cost.iron)
    if (bestSum === null || sum.lt(bestSum)) {
      bestSum = sum
      best = id
    }
  }

  return best === null ? null : { kind: 'build', id: best }
}
