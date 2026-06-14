import { LOYALTY_NOBLE_HIT, LOYALTY_MAX } from '../systems/conquest'

/**
 * Shared conquest copy for the offensive screens (the „Mapa" detail card and the
 * „Wyprawy" target list). Centralised in ONE module so the two screens stay in
 * LOCKSTEP (a review found their conquest hints had drifted apart) and so the quoted
 * numbers — how much loyalty one surviving noble removes, and roughly how many clean
 * wins a capture takes — are DERIVED from the engine knobs ({@link LOYALTY_NOBLE_HIT} /
 * {@link LOYALTY_MAX}) rather than hardcoded in prose, so they can never disagree with
 * the actual conquest maths. Pure data (no DOM); panels render it into their own nodes.
 *
 * Cycle-safe: imports only value constants from systems/conquest.ts, which imports
 * nothing from the UI layer.
 */

/** Rough number of clean (full-loyalty) wins a single-noble army needs to capture a camp. */
export const WINS_TO_CAPTURE = Math.ceil(LOYALTY_MAX / LOYALTY_NOBLE_HIT)

/**
 * Conquest hint shown when the active village CANNOT yet field a Szlachcic (no Pałac):
 * the prerequisite PLUS the mechanic facts (per-win drop + regeneration), so the
 * loyalty bars the player already sees on every camp are explained before they can act.
 */
export const CONQUEST_HINT_LOCKED =
  'Przejmowanie wiosek wymaga szlachcica — najpierw zbuduj Pałac, aby go szkolić. ' +
  'Każdy ocalały szlachcic w wygranym ataku obniża lojalność o ~' +
  LOYALTY_NOBLE_HIT +
  ' (≈' +
  WINS_TO_CAPTURE +
  ' wygrane), a lojalność powoli regeneruje się między atakami.'

/**
 * Conquest hint shown when the active village CAN field a Szlachcic (Pałac built): the
 * active mechanic, including the two facts a review found missing — each surviving noble
 * removes ~LOYALTY_NOBLE_HIT loyalty (≈WINS_TO_CAPTURE wins) AND loyalty regenerates
 * between attacks, so a capture needs a SERIES of strikes, not a single hit.
 */
export const CONQUEST_HINT_ACTIVE =
  'Przejmowanie: wysyłaj szlachcica w wygranych atakach — każdy ocalały obniża lojalność o ~' +
  LOYALTY_NOBLE_HIT +
  ' (≈' +
  WINS_TO_CAPTURE +
  ' wygrane). Lojalność powoli regeneruje się między atakami, więc atakuj seriami; ' +
  'przy 0 wioska zostaje przejęta i staje się Twoja.'

/** Pick the conquest hint for whether the active village can already field a noble. */
export function conquestHint(nobleUnlocked: boolean): string {
  return nobleUnlocked ? CONQUEST_HINT_ACTIVE : CONQUEST_HINT_LOCKED
}
