#!/usr/bin/env python3
"""Build web/lineup-starters.json for the lineup-efficiency page (web/lineups.html).

Reads the commissioner's weekly stats workbook (2026weeklystatsWK<N>.xlsx),
tab "Wkly Player Tab" (Year, Week, Team, Opp, Pos, Player, Stats, Points),
and records each team's 11 starters per week, with every player name resolved
to the exact name used on that team's roster in web/weekly.html (ROSTER_DATA,
waiver moves applied). The page scores everyone from Supabase; the
commissioner's points are kept only so the page can flag any disagreement.

Usage:
    python3 src/build_lineup_starters.py path/to/2026weeklystatsWK6.xlsx
    python3 src/build_lineup_starters.py WK6.xlsx --check   # report only, write nothing

Exits non-zero, writing nothing, if any starter can't be matched to his
team's roster or a team-week doesn't have exactly 11 slots. Name fixes it
had to make (sheet typos) are printed so they can be eyeballed.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import unicodedata

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEEKLY = os.path.join(ROOT, "web", "weekly.html")
OUT = os.path.join(ROOT, "web", "lineup-starters.json")

SHEET_TEAM = {"O&S": "OS"}          # sheet code -> ROSTER_DATA code
EMPTY = {"none available", "none", ""}
SLOTS = {"K", "QB", "RB", "WR", "TE/WR", "DL/LB", "DB"}

# Same spelling map as web/weekly.html, plus typos seen in the commissioner's sheet.
ALIASES = {
    "ken walker": "kenneth walker", "kenny gainwell": "kenneth gainwell",
    "quentin johnson": "quentin johnston", "omarion hamption": "omarion hampton",
    "tyler allegeier": "tyler allgeier", "michael piuttman": "michael pittman",
    "omarian hampton": "omarion hampton", "luther burdon": "luther burden",
    "treyveyon henderson": "treveyon henderson",
}


def norm(s: str) -> str:
    k = unicodedata.normalize("NFKD", str(s))
    k = "".join(c for c in k if not unicodedata.combining(c)).lower()
    k = re.sub(r"[.'’\-]", "", k)
    k = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", k)
    k = re.sub(r"\s+", " ", k).strip()
    return ALIASES.get(k, k)


def load_rosters():
    html = open(WEEKLY, encoding="utf-8").read()
    m = re.search(r"const ROSTER_DATA = (\{.*?\});\n", html)
    if not m:
        sys.exit("could not find ROSTER_DATA in web/weekly.html")
    return json.loads(m.group(1))


def roster(rd, team: str, week: int):
    r = [list(x) for x in rd["base"][team]]
    for eff, code, drop, slot, name, nfl in rd["waivers"]:
        if code == team and eff <= week:
            for i, x in enumerate(r):
                if norm(x[1]) == norm(drop):
                    r[i] = [slot, name, nfl]
                    break
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook")
    ap.add_argument("--check", action="store_true", help="report only; don't write the JSON")
    a = ap.parse_args()

    rd = load_rosters()
    wb = openpyxl.load_workbook(a.workbook, data_only=True, read_only=True)
    ws = wb["Wkly Player Tab"]

    weeks: dict[str, dict[str, list]] = {}
    errors, fixes = [], []
    for row in list(ws.iter_rows(values_only=True))[1:]:
        if not row or row[1] is None or not row[2]:
            continue
        _, wk, team, _opp, pos, player, _stats, pts = row[:8]
        wk = int(wk)
        code = SHEET_TEAM.get(team, team)
        if code not in rd["base"]:
            errors.append((wk, f"wk{wk}: unknown team code {team!r}"))
            continue
        pos = str(pos).strip()
        if pos not in SLOTS:
            errors.append((wk, f"wk{wk} {team}: unknown slot {pos!r} for {player}"))
        raw = str(player or "").strip()
        pts = float(pts or 0)
        name = None
        if raw.lower() not in EMPTY:
            ros = roster(rd, code, wk)
            by = {norm(n): n for _, n, _ in ros}
            name = by.get(norm(raw))
            if name is None:
                close = difflib.get_close_matches(norm(raw), list(by), n=1, cutoff=0.85)
                if close:
                    name = by[close[0]]
                    fixes.append((wk, f"wk{wk} {team}: sheet '{raw}' -> roster '{name}'"))
                else:
                    errors.append((wk, f"wk{wk} {team}: starter '{raw}' is not on the roster"))
                    name = "?"
        weeks.setdefault(str(wk), {}).setdefault(code, []).append([pos, name, pts])

    # Only keep weeks that are complete (all 8 teams with 11 slots); a partially
    # filled week in a mid-week workbook is skipped rather than half-published.
    complete = {}
    for wk, teams in sorted(weeks.items(), key=lambda kv: int(kv[0])):
        # 11 slots each, and mostly named: the sheet carries blank template rows
        # for weeks that haven't been played yet.
        bad = [t for t in rd["base"] if len(teams.get(t, [])) != 11
               or sum(1 for _, n, _ in teams.get(t, []) if n) < 9]
        if bad:
            print(f"week {wk}: skipped, incomplete for {', '.join(bad)}")
            continue
        complete[wk] = {t: teams[t] for t in rd["base"]}

    # Only problems inside weeks we're publishing matter; the sheet often carries
    # partly pre-filled future weeks.
    for wk, f in fixes:
        if str(wk) in complete:
            print("name fix:", f)
    errors = [e for wk, e in errors if str(wk) in complete]
    if errors:
        for e in errors:
            print("ERROR:", e)
        sys.exit(1)
    if not complete:
        sys.exit("no complete weeks found")

    out = {
        "source": os.path.basename(a.workbook),
        "through": max(int(w) for w in complete),
        "note": "Starters per team-week from the commissioner's 'Wkly Player Tab'. "
                "Names are the roster names in web/weekly.html; points are the commissioner's. "
                "Built by src/build_lineup_starters.py.",
        "weeks": complete,
    }
    print(f"weeks {', '.join(complete)} complete; through week {out['through']}")
    if a.check:
        return
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print("wrote", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    main()
