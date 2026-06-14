import type { GameState } from '../src/engine/state'

/**
 * Bot-player heuristic. The runner consults it once per simulated step so the
 * harness exercises the same code paths a real player would drive.
 */
export interface BotAction {
  /** Discriminator for the kind of action (e.g. 'build', 'recruit', 'perk'). */
  kind: string
}

/**
 * Choose the next action for the bot, or null when nothing is worth doing.
 *
 * M0: the economy is purely passive (resources accrue on their own), so there
 * is nothing to buy yet — always returns null.
 *
 * M1: buy the cheapest profitable action (building / unit / perk), ranked by
 * effect-per-cost, given the current resources in `state`.
 */
export function chooseAction(state: GameState): BotAction | null {
  // Touch `state` so the parameter is "used" under noUnusedParameters; the M1
  // heuristic will read resources/buildings from it to rank purchases.
  void state
  return null
}
