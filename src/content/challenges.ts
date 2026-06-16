/**
 * Challenge catalogue (M8 — WYZWANIA) — PURE DATA (no engine logic lives here).
 *
 * A challenge is a CONSTRAINED run for a ONE-TIME, PERMANENT reward. Starting one RESETS
 * the run (fresh capital + world from a deterministic seed, tech/log cleared — like an
 * ascend) and turns on the {@link ChallengeDef.constraint} penalties for as long as it is
 * active; the META accounts (prestige/era/dynasty) and the lifetime stats/achievements are
 * PRESERVED. Reaching the {@link ChallengeDef.goal} (a CURRENT-RUN metric — never a
 * lifetime stat, which would persist across runs) records the challenge permanently and
 * grants its {@link ChallengeDef.reward} bonus FOREVER. Earned rewards STACK.
 *
 * Both the constraint and the reward are expressed as a {@link ChallengeMods} bag, so the
 * whole feature reuses the same `combine` fold as the tech / prestige / era / dynasty bags
 * (systems/challenges.ts `aggregateChallengeMods`): no new economic fold beyond one extra
 * combine() in `effectiveMods`. v1 uses ONLY the six MULTIPLICATIVE kinds (a constraint
 * factor is < 1, a reward factor > 1); the reduction fractions and automation flags stay
 * at identity (the [0, cap] clamp cannot represent a penalty).
 *
 * Import discipline: this module imports nothing from the engine at runtime (it is PURE
 * DATA), so it can never form an initialisation cycle (mirrors content/era.ts).
 */

/**
 * A PARTIAL multiplicative spec — the six global multiplier axes, each OPTIONAL (an absent
 * field means "x1", no change). Used both for a challenge's active CONSTRAINT (penalty
 * factors < 1) and for its permanent REWARD (bonus factors > 1). They map directly onto
 * the matching {@link import('../engine/state').TechModifiers} multiplier fields:
 * `productionMult` scales ALL three resources' production, `storageMult` the storage cap,
 * `popMult` the population cap, and `attackMult` / `defenseMult` / `lootMult` the combat
 * and haul multipliers.
 */
export interface ChallengeMods {
  productionMult?: number
  storageMult?: number
  popMult?: number
  attackMult?: number
  defenseMult?: number
  lootMult?: number
}

/**
 * The win condition of a challenge — always a CURRENT-RUN metric (not a lifetime stat,
 * since those persist across runs and would let an old career trivially satisfy a fresh
 * challenge). Two kinds:
 *  - `prestige_score`: the run's `prestigeScore` (building + tech + village progress) must
 *    reach `target`;
 *  - `production`: the run's current TOTAL production/sec (summed across every village and
 *    every resource) must reach `target`.
 */
export type ChallengeGoal =
  | { kind: 'prestige_score'; target: number }
  | { kind: 'production'; target: number }

export interface ChallengeDef {
  /** Stable id (the key under {@link CHALLENGE_IDS}); what `activeId` / `completed` point at. */
  id: string
  /** Display name (PL). */
  name: string
  /** Short description (PL). */
  desc: string
  /** Penalty multipliers active for the whole run while this challenge is the active one. */
  constraint: ChallengeMods
  /** The current-run metric + threshold that completes the challenge. */
  goal: ChallengeGoal
  /** Permanent bonus multipliers granted ONCE on completion (stack with other rewards). */
  reward: ChallengeMods
  /** Human-readable summary of {@link reward} for the UI (PL). */
  rewardText: string
}

/**
 * The challenge catalogue — distinct, flavourful constrained runs. Each pairs a single
 * crippling CONSTRAINT with a current-run GOAL and a permanent REWARD on a different axis,
 * so completing them all builds a rounded permanent bonus. Pure data; the Balance phase /
 * sim tunes the goal targets and reward magnitudes here, never in the engine.
 */
export const CHALLENGES: ChallengeDef[] = [
  {
    id: 'bieda',
    name: 'Bieda',
    desc: 'Skrajny niedostatek: produkcja wszystkich surowców drastycznie spada. Mimo to rozbuduj wioskę i drzewo na tyle, by osiągnąć wymagany wynik prestiżu.',
    constraint: { productionMult: 0.4 },
    goal: { kind: 'prestige_score', target: 120 },
    reward: { productionMult: 1.15 },
    rewardText: 'Trwale +15% produkcji wszystkich surowców.',
  },
  {
    id: 'pacyfista',
    name: 'Pacyfista',
    desc: 'Droga pokoju: siła ataku twoich wojsk jest mocno osłabiona. Postaw na gospodarkę i osiągnij wymaganą łączną produkcję na sekundę.',
    constraint: { attackMult: 0.5 },
    goal: { kind: 'production', target: 30 },
    reward: { lootMult: 1.25 },
    rewardText: 'Trwale +25% łupów z wypraw.',
  },
  {
    id: 'forsowny_marsz',
    name: 'Forsowny marsz',
    desc: 'Cała siła w natarciu, nic w obronie: obrona wojsk jest poważnie osłabiona, więc najazdy i hordy biją mocniej. Przetrwaj i osiągnij wymagany wynik prestiżu.',
    constraint: { defenseMult: 0.5 },
    goal: { kind: 'prestige_score', target: 180 },
    reward: { attackMult: 1.2 },
    rewardText: 'Trwale +20% siły ataku wojsk.',
  },
  {
    id: 'klatwa_glodu',
    name: 'Klątwa głodu',
    desc: 'Głód dziesiątkuje ludność: limit populacji jest o połowę mniejszy, więc utrzymasz dużo mniejszą armię. Rozkręć mimo to gospodarkę do wymaganej łącznej produkcji.',
    constraint: { popMult: 0.5 },
    goal: { kind: 'production', target: 45 },
    reward: { popMult: 1.2 },
    rewardText: 'Trwale +20% limitu populacji.',
  },
]

/**
 * Stable id list — the single source of iteration order for every order-sensitive pass
 * (aggregateChallengeMods over completed rewards, validation, the UI). Source order here =
 * the catalogue order above; keep it stable when extending (append) so saves/round-trips
 * stay reproducible.
 */
export const CHALLENGE_IDS: readonly string[] = CHALLENGES.map((c) => c.id)
