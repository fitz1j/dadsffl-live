#!/usr/bin/env python3
"""
Parse a raw ESPN box score JSON (from site.api.espn.com .../summary?event=)
into one raw stat-line dict per player, matching the DadsFFL stat_lines
schema columns.

Key data-quality finding this parser accounts for: ESPN's 'defensive'
statistics category TD column is a TOTAL of that player's defensive
touchdowns, and ALREADY INCLUDES interception-return and fumble-return
scores. The 'interceptions' category also has its own TD column for the
same play. Naively summing both would double-count a pick-six. This parser
uses 'defensive'.TD as the sole source for def_td and does NOT add
'interceptions'.TD on top of it.

Two fields are NOT available as structured per-player columns anywhere in
this endpoint and are recovered from `scoringPlays[].text` instead:
  - Field goal distance (needed for our distance-bucketed FG scoring) --
    the 'kicking' category only gives aggregate makes/attempts, not each
    kick's distance.
  - Two-point conversions -- there's no dedicated stat column; successful/
    failed conversions are embedded as a parenthetical suffix on the
    touchdown scoring play's text.

CAVEATS (flagging honestly rather than pretending these are fully proven):
  - No game in the Week 1, 2025 fixture set contains a safety, so the
    safety-detection logic below is untested against a real example.
  - No game in this fixture set contains a *successful* two-point RUN
    conversion (only successful pass conversions, and failed run/pass
    conversions) -- so the run-conversion text pattern is a best guess
    based on ESPN's general phrasing conventions, not a verified match.
Both should be re-checked against a real example before we trust them.
"""

import json
import re
from collections import defaultdict
from pathlib import Path

# ESPN box score 'statistics' category names we read, and which schema
# fields each category's labeled columns map to.
# NOTE: no end-anchor. ESPN sometimes emits the FG scoring-play text with a
# trailing space (e.g. "Chris Boswell 60 Yd Field Goal "), and anchoring to $
# silently dropped those kicks. Gating on play_type == "Field Goal Good"
# already guarantees this is a made FG, so matching the leading part is safe.
FG_GOOD_RE = re.compile(r"^(?P<kicker>.+?) (?P<yards>\d+) Yd Field Goal")

# Two-point conversions are emitted as a PARENTHETICAL on the touchdown scoring
# play, e.g. "... (Brock Purdy Pass to Jauan Jennings for Two-Point Conversion)".
# We extract each parenthetical's contents and parse THAT, rather than anchoring
# to the start of the whole play text (the old bug: a `^`-anchored regex captured
# the passer as the entire pre-paren prefix, so the QB never got credited -- only
# the receiver did).
PAREN_RE = re.compile(r"\(([^()]*)\)")
TWO_PT_PASS_RE = re.compile(
    r"^(?P<passer>.+?) Pass to (?P<receiver>.+?) for Two-Point Conversion$"
)
TWO_PT_RUN_RE = re.compile(r"^(?P<rusher>.+?) Run for Two-Point Conversion$")

SAFETY_RE = re.compile(r"\bSafety\b", re.IGNORECASE)


def _blank_stat_line() -> dict:
    return {
        "pat_made": 0,
        "fg_yards": [],  # exact distance of each made FG; scoring engine buckets via FG_POINTS
        "pass_yards": 0,
        "pass_td": 0,
        "rush_yards": 0,
        "rush_td": 0,
        "receptions": 0,
        "rec_yards": 0,
        "rec_td": 0,
        "def_td": 0,
        "fumble_td": 0,   # offensive fumble-recovery TD (not in rush/rec/def stats)
        "return_td": 0,
        "two_pt_conv": 0,
        "sacks": 0.0,
        "interceptions": 0,
        "safeties": 0,
    }




def parse_box_score(path: Path) -> dict:
    """Returns dict keyed by ESPN athlete id -> {'name', 'team', stat fields...}"""
    data = json.loads(path.read_text())
    event_id = data.get("header", {}).get("id") or path.stem

    stats_by_athlete = defaultdict(_blank_stat_line)
    names = {}
    teams = {}
    defensive_ids = set()   # athletes appearing in the 'defensive' category

    for team_block in data["boxscore"]["players"]:
        team_abbr = team_block["team"]["abbreviation"]
        for category in team_block["statistics"]:
            cat_name = category["name"]
            labels = category["labels"]
            for entry in category.get("athletes", []):
                athlete = entry["athlete"]
                aid = athlete["id"]
                names[aid] = athlete["displayName"]
                teams[aid] = team_abbr
                stat_map = dict(zip(labels, entry["stats"]))
                line = stats_by_athlete[aid]

                if cat_name == "passing":
                    line["pass_yards"] += _to_int(stat_map.get("YDS"))
                    line["pass_td"] += _to_int(stat_map.get("TD"))
                elif cat_name == "rushing":
                    line["rush_yards"] += _to_int(stat_map.get("YDS"))
                    line["rush_td"] += _to_int(stat_map.get("TD"))
                elif cat_name == "receiving":
                    line["receptions"] += _to_int(stat_map.get("REC"))
                    line["rec_yards"] += _to_int(stat_map.get("YDS"))
                    line["rec_td"] += _to_int(stat_map.get("TD"))
                elif cat_name == "defensive":
                    line["def_td"] += _to_int(stat_map.get("TD"))
                    line["sacks"] += _to_float(stat_map.get("SACKS"))
                    defensive_ids.add(aid)
                elif cat_name == "interceptions":
                    # INT count only -- do NOT add this category's TD column,
                    # it duplicates 'defensive'.TD for the same pick-six (see
                    # module docstring).
                    line["interceptions"] += _to_int(stat_map.get("INT"))
                elif cat_name in ("kickReturns", "puntReturns"):
                    line["return_td"] += _to_int(stat_map.get("TD"))
                elif cat_name == "kicking":
                    xp = stat_map.get("XP", "0/0")
                    made, _ = _split_made_attempts(xp)
                    line["pat_made"] += made
                    # FG makes are counted here for a total sanity check, but
                    # bucketed FG_0_39.. counts are filled in from
                    # scoringPlays below (distance isn't in this category).

    # Field goal distances + two-point conversions: recovered from scoringPlays text.
    for play in data.get("scoringPlays", []):
        play_type = play.get("type", {}).get("text", "")
        text = play.get("text", "")

        if play_type == "Field Goal Good":
            m = FG_GOOD_RE.match(text)
            if m:
                kicker_name = m.group("kicker")
                yards = int(m.group("yards"))
                aid = _find_athlete_id_by_name(names, kicker_name)
                if aid:
                    stats_by_athlete[aid]["fg_yards"].append(yards)

        # Offensive fumble-recovery touchdowns (e.g. an RB falling on his QB's
        # fumble in the end zone) don't appear in the rushing/receiving OR the
        # defensive stat categories, so they must come from scoringPlays. We
        # only credit players NOT in the 'defensive' category, because defensive
        # fumble-return TDs are already counted via def_td (avoids double-count).
        if play_type == "Fumble Return Touchdown":
            for aid, nm in names.items():
                if aid in defensive_ids:
                    continue
                pat = (re.escape(nm) +
                       r"(?: \d+ Yd Fumble (?:Recovery|Return)"
                       r"| Fumble Recovery in End Zone"
                       r"| Recovered Kickoff in End Zone)")
                if re.search(pat, text):
                    stats_by_athlete[aid]["fumble_td"] += 1
                    break

        if play_type == "Safety":
            # Credit the individual defender who caused the safety. Two forms:
            #   "... Sacked by <Player> For N Yd Loss for Safety"  -> the sacker
            #   "<Player> Safety"                                   -> that player
            # Team/penalty safeties ("Team Safety", "... Holding ... for Safety")
            # have no individual to credit and are skipped.
            m = re.search(r"Sacked by (?P<p>.+?) For ", text)
            if not m:
                m = re.match(r"(?P<p>[A-Z][\w.'-]+(?: [A-Z][\w.'-]+)+) Safety$", text)
            if m:
                who = m.group("p").strip()
                if who != "Team":
                    aid = _find_athlete_id_by_name(names, who)
                    if aid:
                        stats_by_athlete[aid]["safeties"] += 1

        # Two-point conversions live inside a parenthetical on the TD play.
        # Parse each parenthetical independently so passer/receiver names are
        # clean (not the whole pre-paren prefix).
        for inner in PAREN_RE.findall(text):
            inner = inner.strip()
            if "Two-Point" not in inner or "Conversion" not in inner:
                continue
            if "Failed" in inner:
                # A defender who intercepts/returns a FAILED two-point conversion
                # scores 2 in this league (confirmed 2026-08-17). e.g.
                # "Two-Point Pass Conversion Failed. Minkah Fitzpatrick Interception Return".
                # Counted in two_pt_conv (also worth 2). Otherwise no points for a fail.
                md = re.search(
                    r"Conversion Failed\.?\s*(?P<p>[A-Z][\w.'-]+(?: [A-Z][\w.'-]+)+)"
                    r" (?:Interception|Fumble) Return",
                    inner,
                )
                if md:
                    aid = _find_athlete_id_by_name(names, md.group("p").strip())
                    if aid:
                        stats_by_athlete[aid]["two_pt_conv"] += 1
                continue
            mp = TWO_PT_PASS_RE.match(inner)
            if mp:
                for who in (mp.group("passer"), mp.group("receiver")):
                    aid = _find_athlete_id_by_name(names, who.strip())
                    if aid:
                        stats_by_athlete[aid]["two_pt_conv"] += 1
                continue
            mr = TWO_PT_RUN_RE.match(inner)
            if mr:
                aid = _find_athlete_id_by_name(names, mr.group("rusher").strip())
                if aid:
                    stats_by_athlete[aid]["two_pt_conv"] += 1

    result = {}
    for aid, line in stats_by_athlete.items():
        line = dict(line)
        line["athlete_id"] = aid
        line["name"] = names.get(aid)
        line["team"] = teams.get(aid)
        line["event_id"] = event_id
        result[aid] = line
    return result


def _to_int(v) -> int:
    if v is None:
        return 0
    try:
        return int(v)
    except ValueError:
        return 0


def _to_float(v) -> float:
    if v is None:
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


def _split_made_attempts(s: str) -> tuple[int, int]:
    try:
        made, att = s.split("/")
        return int(made), int(att)
    except (ValueError, AttributeError):
        return 0, 0


def _find_athlete_id_by_name(names: dict, display_name: str):
    display_name = display_name.strip()
    for aid, n in names.items():
        if n == display_name:
            return aid
    return None


if __name__ == "__main__":
    import sys

    p = Path(sys.argv[1])
    parsed = parse_box_score(p)
    for aid, line in sorted(parsed.items(), key=lambda kv: kv[1]["name"] or ""):
        print(line)
