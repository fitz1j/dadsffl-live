#!/usr/bin/env python3
"""
DadsFFL live scoring — fetch ESPN box scores, run them through our real parser +
scoring engine, and render a self-contained live scoreboard of PLAYER fantasy
points. Built to validate the read-from-ESPN -> parse -> score chain on live
(pre)season games, before any fantasy rosters/lineups exist.

Because it needs raw ESPN JSON (the parser recovers FG distances and 2-pt
conversions from scoringPlays), it must run where there's real internet:
  - your Mac's Terminal, or
  - GitHub Actions.
The cloud Cowork sandbox can't reach ESPN, so for offline testing use --from-dir.

Usage:
  # live: score every in-progress NFL game, refresh the page every 30s
  python3 live_score.py --live --watch 30

  # a single game by ESPN event id (find ids on the ESPN scoreboard)
  python3 live_score.py --game 401873272

  # offline test against stored raw fixtures (what we use in the sandbox)
  python3 live_score.py --from-dir ../data/espn_fixtures/2025/week1 --out ../web/live.html

Writes a self-contained web/live.html. Open it in a browser; with --watch it
regenerates on a loop and the page auto-refreshes.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from espn_parser import parse_box_score
from scoring_engine import score_stat_line

SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={}"
SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "web" / "live.html"
TEMPLATE = HERE.parent / "web" / "live.template.html"


# ---- fetch (needs internet; used on Mac / GitHub Actions) ----------------------

def curl_json(url: str) -> dict:
    """Fetch JSON with curl. Plain request — do NOT spoof a User-Agent (ESPN 403s
    on some spoofed agents). Returns {} on failure."""
    try:
        out = subprocess.run(
            ["curl", "-s", "--max-time", "20", url],
            capture_output=True, text=True, timeout=25,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return {}
        return json.loads(out.stdout)
    except Exception:
        return {}


def live_game_ids() -> list[str]:
    sb = curl_json(SCOREBOARD_URL)
    ids = []
    for ev in sb.get("events", []):
        state = ev.get("status", {}).get("type", {}).get("state")
        if state in ("in", "post"):   # in-progress or final
            ids.append(ev["id"])
    return ids


def fetch_summary_to_file(game_id: str, cache_dir: Path) -> Path | None:
    data = curl_json(SUMMARY_URL.format(game_id))
    if not data or "boxscore" not in data:
        return None
    cache_dir.mkdir(parents=True, exist_ok=True)
    p = cache_dir / f"{game_id}.json"
    p.write_text(json.dumps(data))
    return p


# ---- game meta (teams, score, status) from a summary JSON ----------------------

def game_meta(path: Path) -> dict:
    data = json.loads(path.read_text())
    comp = (data.get("header", {}).get("competitions") or [{}])[0]
    status = comp.get("status", {}) or data.get("header", {}).get("status", {})
    st = status.get("type", {})
    teams = {}
    for c in comp.get("competitors", []):
        t = c.get("team", {})
        teams[c.get("homeAway", "?")] = {
            "abbrev": t.get("abbreviation", "?"),
            "name": t.get("shortDisplayName") or t.get("name", "?"),
            "score": c.get("score", ""),
        }
    return {
        "state": st.get("state", "?"),          # pre | in | post
        "status": st.get("shortDetail") or st.get("detail") or st.get("description", ""),
        "home": teams.get("home", {}),
        "away": teams.get("away", {}),
    }


# ---- position inference + stat summary (no roster context in preseason) --------

def infer_pos(s: dict) -> str:
    if s.get("fg_yards") or s.get("pat_made"):
        return "K"
    if s.get("sacks") or s.get("interceptions") or s.get("def_td") or s.get("safeties"):
        return "DEF"
    if s.get("return_td"):
        return "RET"
    if s.get("pass_yards") or s.get("pass_td"):
        return "QB"
    if s.get("rush_yards", 0) >= s.get("rec_yards", 0) and s.get("rush_yards"):
        return "RB"
    if s.get("rec_yards") or s.get("receptions"):
        return "WR"
    return "—"


def stat_summary(s: dict) -> str:
    parts = []
    if s.get("pass_yards") or s.get("pass_td"):
        seg = f"{s['pass_yards']} pass yd"
        if s.get("pass_td"):
            seg += f", {s['pass_td']} TD"
        parts.append(seg)
    if s.get("rush_yards") or s.get("rush_td"):
        seg = f"{s['rush_yards']} rush yd"
        if s.get("rush_td"):
            seg += f", {s['rush_td']} TD"
        parts.append(seg)
    if s.get("receptions") or s.get("rec_yards") or s.get("rec_td"):
        seg = f"{s.get('receptions',0)} rec/{s.get('rec_yards',0)} yd"
        if s.get("rec_td"):
            seg += f", {s['rec_td']} TD"
        parts.append(seg)
    if s.get("fg_yards"):
        parts.append("FG " + ", ".join(f"{y}" for y in s["fg_yards"]))
    if s.get("pat_made"):
        parts.append(f"{s['pat_made']} XP")
    if s.get("sacks"):
        parts.append(f"{s['sacks']:g} sk")
    if s.get("interceptions"):
        parts.append(f"{s['interceptions']} INT")
    if s.get("def_td") or s.get("fumble_td"):
        parts.append(f"{s.get('def_td',0)+s.get('fumble_td',0)} def TD")
    if s.get("return_td"):
        parts.append(f"{s['return_td']} ret TD")
    if s.get("safeties"):
        parts.append(f"{s['safeties']} safety")
    if s.get("two_pt_conv"):
        parts.append(f"{s['two_pt_conv']} 2pt")
    return " · ".join(parts)


def build_game(path: Path) -> dict:
    parsed = parse_box_score(path)
    meta = game_meta(path)
    by_team = {}
    for aid, line in parsed.items():
        pts = score_stat_line(line).total
        if pts <= 0:
            continue
        row = {
            "name": line["name"], "team": line["team"],
            "pos": infer_pos(line), "summary": stat_summary(line),
            "pts": round(pts, 1),
        }
        by_team.setdefault(line["team"], []).append(row)
    for team in by_team:
        by_team[team].sort(key=lambda r: -r["pts"])
    return {"meta": meta, "players": by_team}


# ---- render --------------------------------------------------------------------

def render(games: list[dict], out: Path, refresh: int, updated: str):
    payload = {"generated": updated, "refresh": refresh, "games": games}
    tpl = TEMPLATE.read_text()
    html = tpl.replace("/*__DATA__*/ null", json.dumps(payload))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)


def collect(args) -> list[dict]:
    games = []
    if args.from_dir:
        for p in sorted(Path(args.from_dir).glob("*.json")):
            try:
                games.append(build_game(p))
            except Exception as e:
                print(f"  skip {p.name}: {e}", file=sys.stderr)
    else:
        cache = Path(tempfile.gettempdir()) / "dadsffl_live"
        ids = [args.game] if args.game else live_game_ids()
        if not ids:
            print("No live/finished games found on the ESPN scoreboard right now.")
        for gid in ids:
            p = fetch_summary_to_file(gid, cache)
            if p:
                games.append(build_game(p))
            else:
                print(f"  could not fetch game {gid} (no internet from here?)", file=sys.stderr)
    # order: in-progress first, then finals, then pre
    order = {"in": 0, "post": 1, "pre": 2, "?": 3}
    games.sort(key=lambda g: order.get(g["meta"]["state"], 9))
    return games


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", help="single ESPN event id")
    ap.add_argument("--live", action="store_true", help="all in-progress/finished games")
    ap.add_argument("--from-dir", help="score stored raw JSON fixtures (offline test)")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--watch", type=int, default=0, help="re-fetch every N seconds (local loop)")
    ap.add_argument("--refresh", type=int, default=None,
                    help="client-side page auto-reload interval in seconds; "
                         "defaults to --watch. Set this in CI (e.g. 120) so the "
                         "published page reloads to pick up each new deploy.")
    args = ap.parse_args()

    refresh = args.refresh if args.refresh is not None else (args.watch or 0)
    out = Path(args.out)

    def once():
        # e.g. "Wed, Aug 19 · 3:48:14 PM EDT" — date + tz so it's unambiguous
        stamp = time.strftime("%a, %b %-d · %-I:%M:%S %p %Z")
        games = collect(args)
        render(games, out, refresh, stamp)
        n = sum(len(g["players"]) and 1 for g in games)
        print(f"[{stamp}] wrote {out} — {len(games)} games, "
              f"{sum(len(v) for g in games for v in g['players'].values())} scoring players")

    once()
    if args.watch:
        try:
            while True:
                time.sleep(args.watch)
                once()
        except KeyboardInterrupt:
            print("\nstopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
