#!/usr/bin/env python3
"""
DadsFFL custom fantasy scoring engine.

Implements the league's scoring rules as confirmed 2026-08-14 (see the
scoring-rules.md doc in the project for the full raw rule text and the
resolved design decisions this code encodes):

  1. Rushing and receiving yardage bonuses are evaluated SEPARATELY --
     a player's rush_yards and rec_yards are each looked up independently
     in the same bracket table.
  2. Defensive touchdowns (def_td) earn the flat 6-pt "touchdown scored"
     bonus, stacking with stat-specific bonuses (e.g. a pick-six is
     interception[6] + touchdown[6] = 12).
  3. The 5+ reception minimum applies ONLY to the 40-79 yard receiving
     bracket, not to the 80+ brackets.
  4. Punt/kickoff return TD (return_td) is a flat 10 that REPLACES the
     generic 6-pt touchdown bonus for that specific play (it is tracked as
     its own stat, separate from rush_td/rec_td/def_td, so there's no
     double-count to guard against here -- it just uses its own point value).

Overage brackets (FG 70+, passing 600+, rush/rec 260+) are implemented as a
continuation of the SAME bracket width used by the preceding brackets (e.g.
passing brackets are 100 yards wide throughout, so 600-699 continues that
pattern at 17+4=21, 700-799 at 17+8=25, etc). This is a refinement of an
earlier looser assumption and is still UNCONFIRMED with the commissioner --
flagged in scoring-rules.md as an open item.

FG_POINTS is exposed as a standalone, editable table since FG scoring is
explicitly under discussion in the league right now.
"""

from dataclasses import dataclass, field


# --- Configurable bracket tables -------------------------------------------------

FG_POINTS = [  # (max_yards_inclusive, points) -- last entry's width is reused for overage
    (39, 3),
    (49, 4),
    (59, 5),
    (69, 6),
    (79, 7),
]
FG_OVERAGE_UNIT = 10
FG_OVERAGE_INCREMENT = 1  # updated 2026-08-14: FG scoring is now linear +1 per 10-yard bracket

PASSING_YARDS_POINTS = [
    (199, 0),
    (299, 7),
    (399, 10),
    (499, 13),
    (599, 17),
]
PASSING_OVERAGE_UNIT = 100
PASSING_OVERAGE_INCREMENT = 4

RUSH_REC_YARDS_POINTS = [
    (79, 0),  # 60-79 handled separately below for rushing; 0 here is the "no bracket bonus" baseline
    (124, 7),
    (169, 10),
    (214, 13),
    (259, 17),
]
RUSH_REC_OVERAGE_UNIT = 45
RUSH_REC_OVERAGE_INCREMENT = 4

RUSH_LOW_BRACKET = (60, 79, 4)   # yards_min, yards_max, points -- rushing only
REC_LOW_BRACKET = (40, 79, 4)    # yards_min, yards_max, points -- receiving only, requires 5+ catches
REC_LOW_BRACKET_MIN_CATCHES = 5

PAT_POINTS = 1
PASS_TD_POINTS = 3
GENERIC_TD_POINTS = 6          # rushing / receiving / defensive touchdowns
RETURN_TD_POINTS = 10          # punt/kickoff return TD (replaces the generic 6 for that play)
TWO_PT_CONV_POINTS = 2
SACK_POINTS_PER_FULL_SACK = 4  # half sack (0.5) => 2, naturally, via sacks * 4
INTERCEPTION_POINTS = 6
SAFETY_POINTS = 10


def _bracket_lookup(yards: int, table: list[tuple[int, int]], overage_unit: int, overage_increment: int) -> int:
    """Look up `yards` in an ascending (max_yards_inclusive, points) table.
    Beyond the last defined bracket, extend using overage_unit-wide brackets
    at overage_increment per additional bracket."""
    last_max, last_points = table[-1]
    if yards <= last_max:
        points = 0
        for max_yards, pts in table:
            if yards <= max_yards:
                points = pts
                break
        return points
    extra_units = (yards - last_max - 1) // overage_unit + 1
    return last_points + overage_increment * extra_units


def score_fg_yards(yards: int) -> int:
    return _bracket_lookup(yards, FG_POINTS, FG_OVERAGE_UNIT, FG_OVERAGE_INCREMENT)


def score_passing_yards(yards: int) -> int:
    return _bracket_lookup(yards, PASSING_YARDS_POINTS, PASSING_OVERAGE_UNIT, PASSING_OVERAGE_INCREMENT)


def score_rush_or_rec_yards(yards: int) -> int:
    """Shared 80+ bracket table only -- caller adds the low-tier bonus separately."""
    return _bracket_lookup(yards, RUSH_REC_YARDS_POINTS, RUSH_REC_OVERAGE_UNIT, RUSH_REC_OVERAGE_INCREMENT)


@dataclass
class ScoreBreakdown:
    pat: int = 0
    field_goals: int = 0
    passing_yards: int = 0
    passing_td: int = 0
    rushing_yards: int = 0
    rushing_low: int = 0
    receiving_yards: int = 0
    receiving_low: int = 0
    generic_td: int = 0
    return_td: int = 0
    two_pt_conv: int = 0
    sacks: float = 0
    interceptions: int = 0
    safeties: int = 0
    detail: dict = field(default_factory=dict)

    @property
    def total(self) -> float:
        return (
            self.pat + self.field_goals + self.passing_yards + self.passing_td
            + self.rushing_yards + self.rushing_low + self.receiving_yards + self.receiving_low
            + self.generic_td + self.return_td + self.two_pt_conv + self.sacks
            + self.interceptions + self.safeties
        )


def score_stat_line(stat: dict) -> ScoreBreakdown:
    b = ScoreBreakdown()

    b.pat = stat.get("pat_made", 0) * PAT_POINTS

    # Every made FG is scored from its exact distance via the FG_POINTS table.
    # Storing raw distances (not pre-bucketed counts) means an FG rule change
    # only touches FG_POINTS -- no stored data or bucket columns to migrate.
    b.field_goals = sum(score_fg_yards(yards) for yards in stat.get("fg_yards", []))

    pass_yards = stat.get("pass_yards", 0)
    b.passing_yards = score_passing_yards(pass_yards) if pass_yards else 0
    b.passing_td = stat.get("pass_td", 0) * PASS_TD_POINTS

    rush_yards = stat.get("rush_yards", 0)
    if rush_yards >= 80:
        b.rushing_yards = score_rush_or_rec_yards(rush_yards)
    elif RUSH_LOW_BRACKET[0] <= rush_yards <= RUSH_LOW_BRACKET[1]:
        b.rushing_low = RUSH_LOW_BRACKET[2]

    rec_yards = stat.get("rec_yards", 0)
    receptions = stat.get("receptions", 0)
    if rec_yards >= 80:
        b.receiving_yards = score_rush_or_rec_yards(rec_yards)
    elif (
        REC_LOW_BRACKET[0] <= rec_yards <= REC_LOW_BRACKET[1]
        and receptions >= REC_LOW_BRACKET_MIN_CATCHES
    ):
        b.receiving_low = REC_LOW_BRACKET[2]

    generic_tds = (stat.get("rush_td", 0) + stat.get("rec_td", 0)
                   + stat.get("def_td", 0) + stat.get("fumble_td", 0))
    b.generic_td = generic_tds * GENERIC_TD_POINTS
    b.return_td = stat.get("return_td", 0) * RETURN_TD_POINTS

    b.two_pt_conv = stat.get("two_pt_conv", 0) * TWO_PT_CONV_POINTS
    b.sacks = stat.get("sacks", 0) * SACK_POINTS_PER_FULL_SACK
    b.interceptions = stat.get("interceptions", 0) * INTERCEPTION_POINTS
    b.safeties = stat.get("safeties", 0) * SAFETY_POINTS

    return b
