import { battleOutcome, WORST_LUCK, BEST_LUCK, COMBAT_LUCK } from '../systems/combat'

/**
 * Shared battle-forecast copy + verdict for the offensive screens (the „Mapa" detail
 * card and the „Wyprawy" target list). Centralised in ONE module so the two screens
 * stay in LOCKSTEP (mirrors {@link ./conquestCopy}) and so the thresholds, the worded
 * verdict and the confirm warnings are DERIVED from the same combat knobs
 * ({@link WORST_LUCK} / {@link BEST_LUCK} / {@link COMBAT_LUCK}) the engine actually
 * resolves with — never hardcoded twice. Pure data (no DOM); panels render it into
 * their own nodes and toggle their own classes.
 *
 * M5.5 — combat LUCK. Every resolved engagement multiplies the ATTACKER's power by a
 * uniform roll in [WORST_LUCK, BEST_LUCK] = 1 ± COMBAT_LUCK (mean 1.0). So a fight the
 * average power would win can still be lost on a bad roll, and vice-versa. The forecast
 * therefore reports a THREE-state verdict against the same effective defence the engine
 * uses (base × ram factor), so what the player is shown can never disagree with the
 * outcome the tick rolls. The verdict is carried in WORDS (and a glyph), never colour
 * alone (WCAG 1.4.1) — `cls` is only a supplementary tint.
 *
 * Cycle-safe: imports only pure functions/constants from systems/combat.ts, which never
 * reaches into the UI layer.
 */

/**
 * The three-tier forecast (the loss tier splits into two worded flavours):
 *  - `certain-win`  — wins even at WORST luck (atk·WORST_LUCK > def): guaranteed.
 *  - `probable`     — wins on AVERAGE (atk > def) but a bad roll flips it to a loss.
 *  - `risky`        — loses on average, yet a GOOD roll could still win (atk·BEST_LUCK > def).
 *  - `certain-loss` — cannot win even at BEST luck (atk·BEST_LUCK ≤ def): hopeless.
 */
export type ForecastKind = 'certain-win' | 'probable' | 'risky' | 'certain-loss'

export interface AttackForecast {
  kind: ForecastKind
  /** True ONLY for a guaranteed win (wins even at worst luck) — gates the no-warn send. */
  certainWin: boolean
  /** Glyph + worded verdict; the WORDS carry the meaning (never colour alone). */
  text: string
  /** Supplementary state class: green win / red loss, '' = luck-dependent (neutral). */
  cls: '' | 'forecast-win' | 'forecast-lose'
}

/** ±N% as a whole percent, derived from the engine knob (e.g. 25). */
export const LUCK_PCT = Math.round(COMBAT_LUCK * 100)

/**
 * One-line, reusable note stating the luck band in TEXT (never colour alone), so the
 * three-state verdict is understood. Shown once per offensive screen, not per card.
 */
export const LUCK_NOTE =
  'Szczęście losuje siłę ataku o ±' +
  LUCK_PCT +
  '% przy każdym starciu — dlatego prognoza podaje, czy wygrana jest pewna, prawdopodobna czy ryzykowna.'

/** Round a loss FRACTION (0..1) to a whole percent for display. */
function lossPct(frac: number): number {
  return Math.round(frac * 100)
}

/**
 * Classify an attack from the attacker's (luck-free) power and the EFFECTIVE defence
 * (base × ram factor) the engine will fight with. Compares atk·WORST_LUCK / atk /
 * atk·BEST_LUCK against `effDef` to land in one of the four tiers above, mirroring the
 * roll the march/raid engine applies (luckFactor on atkPower BEFORE battleOutcome).
 *
 * For a CERTAIN win the loss estimate is a RANGE — best-luck (lightest) to worst-luck
 * (heaviest) casualties — since both extremes still win; for a PROBABLE win it is the
 * mean-luck loss with the pech caveat. Pure: no clock, no RNG, no DOM.
 */
export function attackForecast(atkPow: number, effDef: number): AttackForecast {
  // CERTAIN WIN: wins even on the worst roll. Losses span best→worst luck (both win).
  if (atkPow * WORST_LUCK > effDef) {
    const lossBest = lossPct(battleOutcome(atkPow * BEST_LUCK, effDef).attackerLossFrac)
    const lossWorst = lossPct(battleOutcome(atkPow * WORST_LUCK, effDef).attackerLossFrac)
    const range = lossBest === lossWorst ? '~' + lossWorst + '%' : '~' + lossBest + '–' + lossWorst + '%'
    return { kind: 'certain-win', certainWin: true, text: '✓︎ pewna wygrana · straty ' + range, cls: 'forecast-win' }
  }
  // PROBABLE: wins at mean luck, but a bad roll (−luck) flips it to a wipe.
  if (atkPow > effDef) {
    const mean = lossPct(battleOutcome(atkPow, effDef).attackerLossFrac)
    return {
      kind: 'probable',
      certainWin: false,
      text: '≈ prawdopodobna wygrana · straty ~' + mean + '% (przy pechu porażka)',
      cls: '',
    }
  }
  // RISKY: loses on average, yet a good roll (+luck) could still pull off a win.
  if (atkPow * BEST_LUCK > effDef) {
    return {
      kind: 'risky',
      certainWin: false,
      text: '⚠︎ ryzykowna · średnio porażka, wygrana tylko przy szczęściu',
      cls: '',
    }
  }
  // CERTAIN LOSS: cannot win even on the best roll.
  return { kind: 'certain-loss', certainWin: false, text: '✗︎ pewna porażka', cls: 'forecast-lose' }
}

/**
 * The confirm() warning shown before dispatching at a SCOUTED camp whose forecast is
 * NOT a certain win — wording adapts to the tier so the player knows exactly what risk
 * they accept. Returns '' for a certain win (no confirmation needed). Keeps both
 * offensive screens phrasing the same risk identically.
 */
export function attackConfirmMessage(fc: AttackForecast): string {
  switch (fc.kind) {
    case 'certain-loss':
      return (
        'Prognoza: pewna porażka — wysłana armia zostanie zniszczona (nawet przy szczęściu +' +
        LUCK_PCT +
        '%). Wysłać mimo to?'
      )
    case 'risky':
      return (
        'Prognoza: ryzykowna — średnio porażka, wygrana tylko przy szczęściu (+' +
        LUCK_PCT +
        '%). Wysłać mimo to?'
      )
    case 'probable':
      return (
        'Prognoza: prawdopodobna wygrana, ale pech (−' +
        LUCK_PCT +
        '%) może ją odwrócić i zniszczyć armię. Wysłać mimo to?'
      )
    default:
      return ''
  }
}

/**
 * Apply a forecast's supplementary tint to an element: clear both state classes, then
 * add the verdict's class if any (neutral/'' = luck-dependent). Centralised so both
 * panels colour the forecast identically; the WORDS still carry the verdict.
 */
export function applyForecastClass(el: HTMLElement, cls: AttackForecast['cls']): void {
  el.classList.remove('forecast-win', 'forecast-lose')
  if (cls) el.classList.add(cls)
}
