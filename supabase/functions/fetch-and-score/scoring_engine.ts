// DadsFFL custom fantasy scoring engine — ported 1:1 from src/scoring_engine.py
// (dadsffl-live repo, commit as of 2026-09-01). Keep this file's logic in lock
// step with the Python original; if the league's rules change, update both.
//
// Rule notes carried over from the Python docstring:
//   1. Rushing and receiving yardage bonuses are evaluated SEPARATELY — a
//      player's rush_yards and rec_yards are each looked up independently in
//      the same bracket table.
//   2. Defensive touchdowns (def_td) earn the flat 6-pt "touchdown scored"
//      bonus, stacking with stat-specific bonuses (e.g. a pick-six is
//      interception[6] + touchdown[6] = 12).
//   3. The 5+ reception minimum applies ONLY to the 40-79 yard receiving
//      bracket, not to the 80+ brackets.
//   4. Punt/kickoff return TD (return_td) is a flat 10 that REPLACES the
//      generic 6-pt touchdown bonus for that specific play (tracked as its
//      own stat, separate from rush_td/rec_td/def_td).
//
// Overage brackets (FG 70+, passing 600+, rush/rec 260+) are implemented as a
// continuation of the SAME bracket width used by the preceding brackets. This
// is UNCONFIRMED with the commissioner — see scoring-rules.md open items.

export type Bracket = readonly [maxYardsInclusive: number, points: number];

// --- Configurable bracket tables -------------------------------------------

export const FG_POINTS: Bracket[] = [
  [39, 3],
  [49, 4],
  [59, 5],
  [69, 6],
  [79, 7],
];
export const FG_OVERAGE_UNIT = 10;
export const FG_OVERAGE_INCREMENT = 1; // linear +1 per 10-yard bracket

export const PASSING_YARDS_POINTS: Bracket[] = [
  [199, 0],
  [299, 7],
  [399, 10],
  [499, 13],
  [599, 17],
];
export const PASSING_OVERAGE_UNIT = 100;
export const PASSING_OVERAGE_INCREMENT = 4;

export const RUSH_REC_YARDS_POINTS: Bracket[] = [
  [79, 0], // 60-79 handled separately for rushing; 0 = "no bracket bonus" baseline
  [124, 7],
  [169, 10],
  [214, 13],
  [259, 17],
];
export const RUSH_REC_OVERAGE_UNIT = 45;
export const RUSH_REC_OVERAGE_INCREMENT = 4;

// yards_min, yards_max, points — rushing only
export const RUSH_LOW_BRACKET = { min: 60, max: 79, points: 4 };
// yards_min, yards_max, points — receiving only, requires 5+ catches
export const REC_LOW_BRACKET = { min: 40, max: 79, points: 4 };
export const REC_LOW_BRACKET_MIN_CATCHES = 5;

export const PAT_POINTS = 1;
export const PASS_TD_POINTS = 3;
export const GENERIC_TD_POINTS = 6; // rushing / receiving / defensive touchdowns
export const RETURN_TD_POINTS = 10; // punt/kickoff return TD (replaces the generic 6)
export const TWO_PT_CONV_POINTS = 2;
export const SACK_POINTS_PER_FULL_SACK = 4; // half sack (0.5) => 2, via sacks * 4
export const INTERCEPTION_POINTS = 6;
export const SAFETY_POINTS = 10;

/** Look up `yards` in an ascending (maxYardsInclusive, points) table. Beyond
 * the last defined bracket, extend using overageUnit-wide brackets at
 * overageIncrement per additional bracket. */
function bracketLookup(
  yards: number,
  table: Bracket[],
  overageUnit: number,
  overageIncrement: number,
): number {
  const [lastMax, lastPoints] = table[table.length - 1];
  if (yards <= lastMax) {
    for (const [maxYards, pts] of table) {
      if (yards <= maxYards) return pts;
    }
    return 0;
  }
  const extraUnits = Math.floor((yards - lastMax - 1) / overageUnit) + 1;
  return lastPoints + overageIncrement * extraUnits;
}

export function scoreFgYards(yards: number): number {
  return bracketLookup(yards, FG_POINTS, FG_OVERAGE_UNIT, FG_OVERAGE_INCREMENT);
}

export function scorePassingYards(yards: number): number {
  return bracketLookup(
    yards,
    PASSING_YARDS_POINTS,
    PASSING_OVERAGE_UNIT,
    PASSING_OVERAGE_INCREMENT,
  );
}

/** Shared 80+ bracket table only — caller adds the low-tier bonus separately. */
export function scoreRushOrRecYards(yards: number): number {
  return bracketLookup(
    yards,
    RUSH_REC_YARDS_POINTS,
    RUSH_REC_OVERAGE_UNIT,
    RUSH_REC_OVERAGE_INCREMENT,
  );
}

/** Raw counting-stat input shape — matches espn_parser.ts's per-player output. */
export interface StatLine {
  pat_made?: number;
  fg_yards?: number[];
  pass_yards?: number;
  pass_td?: number;
  rush_yards?: number;
  rush_td?: number;
  receptions?: number;
  rec_yards?: number;
  rec_td?: number;
  def_td?: number;
  fumble_td?: number;
  return_td?: number;
  two_pt_conv?: number;
  sacks?: number;
  interceptions?: number;
  safeties?: number;
}

export interface ScoreBreakdown {
  pat: number;
  fieldGoals: number;
  passingYards: number;
  passingTd: number;
  rushingYards: number;
  rushingLow: number;
  receivingYards: number;
  receivingLow: number;
  genericTd: number;
  returnTd: number;
  twoPtConv: number;
  sacks: number;
  interceptions: number;
  safeties: number;
  total: number;
}

export function scoreStatLine(stat: StatLine): ScoreBreakdown {
  const b: Omit<ScoreBreakdown, "total"> = {
    pat: (stat.pat_made ?? 0) * PAT_POINTS,

    // Every made FG is scored from its exact distance via FG_POINTS. Storing
    // raw distances (not pre-bucketed counts) means an FG rule change only
    // touches FG_POINTS — no stored data or bucket columns to migrate.
    fieldGoals: (stat.fg_yards ?? []).reduce((sum, y) => sum + scoreFgYards(y), 0),

    passingYards: stat.pass_yards ? scorePassingYards(stat.pass_yards) : 0,
    passingTd: (stat.pass_td ?? 0) * PASS_TD_POINTS,

    rushingYards: 0,
    rushingLow: 0,
    receivingYards: 0,
    receivingLow: 0,

    genericTd:
      ((stat.rush_td ?? 0) + (stat.rec_td ?? 0) + (stat.def_td ?? 0) + (stat.fumble_td ?? 0)) *
      GENERIC_TD_POINTS,
    returnTd: (stat.return_td ?? 0) * RETURN_TD_POINTS,

    twoPtConv: (stat.two_pt_conv ?? 0) * TWO_PT_CONV_POINTS,
    sacks: (stat.sacks ?? 0) * SACK_POINTS_PER_FULL_SACK,
    interceptions: (stat.interceptions ?? 0) * INTERCEPTION_POINTS,
    safeties: (stat.safeties ?? 0) * SAFETY_POINTS,
  };

  const rushYards = stat.rush_yards ?? 0;
  if (rushYards >= 80) {
    b.rushingYards = scoreRushOrRecYards(rushYards);
  } else if (rushYards >= RUSH_LOW_BRACKET.min && rushYards <= RUSH_LOW_BRACKET.max) {
    b.rushingLow = RUSH_LOW_BRACKET.points;
  }

  const recYards = stat.rec_yards ?? 0;
  const receptions = stat.receptions ?? 0;
  if (recYards >= 80) {
    b.receivingYards = scoreRushOrRecYards(recYards);
  } else if (
    recYards >= REC_LOW_BRACKET.min &&
    recYards <= REC_LOW_BRACKET.max &&
    receptions >= REC_LOW_BRACKET_MIN_CATCHES
  ) {
    b.receivingLow = REC_LOW_BRACKET.points;
  }

  const total =
    b.pat +
    b.fieldGoals +
    b.passingYards +
    b.passingTd +
    b.rushingYards +
    b.rushingLow +
    b.receivingYards +
    b.receivingLow +
    b.genericTd +
    b.returnTd +
    b.twoPtConv +
    b.sacks +
    b.interceptions +
    b.safeties;

  return { ...b, total };
}
