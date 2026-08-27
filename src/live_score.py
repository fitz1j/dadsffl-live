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

from __future__ import annotations  # lazy type hints -> runs on Python 3.7+

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

# Optional scoreboard query (?seasontype=T&week=N) so we can target a SPECIFIC
# past week for backfilling the archive. Empty = the current default scoreboard.
SB_QUERY = ""


def sb_url() -> str:
    return SCOREBOARD_URL + SB_QUERY

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "web" / "live.html"
TEMPLATE = HERE.parent / "web" / "live.template.html"

# raw counting stats carried into the archive (so a week can be re-scored later
# / ingested into the DB). Kept out of the live page's inline data to stay lean.
ARCHIVE_STAT_KEYS = [
    "pat_made", "fg_yards", "pass_yards", "pass_td", "rush_yards", "rush_td",
    "receptions", "rec_yards", "rec_td", "def_td", "fumble_td", "return_td",
    "two_pt_conv", "sacks", "interceptions", "safeties",
]
SEASON_TYPE_LABEL = {1: "pre", 2: "reg", 3: "post"}


def week_title(season_type, week) -> str:
    """Human label for a week. ESPN files the Hall of Fame Game as preseason
    week 1, so preseason week N>1 displays as 'Pre Week N-1'."""
    try:
        w = int(week)
    except (TypeError, ValueError):
        return "Week"
    if season_type == 1:
        return "Hall of Fame" if w == 1 else f"Pre Week {w - 1}"
    if season_type == 3:
        return f"Post Week {w}"
    return f"Week {w}"


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


def scoreboard_states():
    """Classify the current NFL scoreboard into (live, final, pre) event-id lists.
    'in' = in progress, 'post' = final, 'pre' = scheduled/not started."""
    sb = curl_json(sb_url())
    live, final, pre = [], [], []
    for ev in sb.get("events", []):
        state = ev.get("status", {}).get("type", {}).get("state")
        if state == "in":
            live.append(ev["id"])
        elif state == "post":
            final.append(ev["id"])
        elif state == "pre":
            pre.append(ev["id"])
    return live, final, pre


def live_game_ids() -> list[str]:
    live, final, _pre = scoreboard_states()
    return live + final   # in-progress or final


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
        pts = round(score_stat_line(line).total, 1)
        summary = stat_summary(line)
        # Keep anyone who either scored OR has a stat line worth showing. Players
        # with a completely empty line (0 everything we parse) are dropped.
        if pts <= 0 and not summary:
            continue
        act = (line.get("pass_yards", 0) + line.get("rush_yards", 0)
               + line.get("rec_yards", 0))   # rough activity, to rank non-scorers
        row = {
            "name": line["name"], "team": line["team"],
            "pos": infer_pos(line), "summary": summary,
            "pts": pts, "scored": pts > 0, "act": act,
            "stats": {k: line.get(k) for k in ARCHIVE_STAT_KEYS},
        }
        by_team.setdefault(line["team"], []).append(row)
    # scorers first (by points), then non-scorers (by activity)
    for team, rows in by_team.items():
        rows.sort(key=lambda r: (0 if r["scored"] else 1,
                                 -r["pts"] if r["scored"] else -r["act"]))
    return {"meta": meta, "players": by_team}


# ---- render --------------------------------------------------------------------

def _strip_stats(games: list[dict]) -> list[dict]:
    """Drop the raw per-player stats from the games (they belong in the archive,
    not inline on the live page — keeps the page's embedded JSON lean)."""
    out = []
    for g in games:
        players = {t: [{k: v for k, v in p.items() if k != "stats"} for p in rows]
                   for t, rows in g["players"].items()}
        out.append({"meta": g["meta"], "players": players})
    return out


def _build_page(payload: dict, out: Path, tpl: str):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(tpl.replace("/*__DATA__*/ null", json.dumps(payload)))


def _weeks_nav(archive_dir: Path) -> list[dict]:
    """Nav entries (newest first) for every archived week: {label,title,url}."""
    idx = archive_dir / "index.json"
    if not idx.exists():
        return []
    try:
        weeks = json.loads(idx.read_text()).get("weeks", [])
    except Exception:
        return []
    return [{"label": w.get("label"),
             "title": week_title(w.get("season_type"), w.get("week")),
             "url": f"week-{w.get('label')}.html"} for w in weeks]


def render_site(games: list[dict], out: Path, refresh: int, updated: str,
                archive_dir: Path | None):
    """Write the live index page AND a standalone page per archived week.
    Week pages are regenerated each run from the committed archive JSON."""
    tpl = TEMPLATE.read_text()
    weeks = _weeks_nav(archive_dir) if archive_dir else []

    _build_page({"mode": "live", "current": "live", "title": "Live",
                 "generated": updated, "refresh": refresh,
                 "games": _strip_stats(games), "weeks": weeks}, out, tpl)

    if archive_dir:
        for p in sorted(archive_dir.glob("*/*.json")):
            if p.name == "index.json":
                continue
            try:
                d = json.loads(p.read_text())
            except Exception:
                continue
            _build_page({"mode": "archive", "current": d.get("label"),
                         "title": week_title(d.get("season_type"), d.get("week")),
                         "generated": d.get("generated"),
                         "refresh": 0, "games": _strip_stats(d.get("games", [])),
                         "weeks": weeks},
                        out.parent / f"week-{d.get('label')}.html", tpl)


def scoreboard_meta() -> tuple:
    """(season_year, season_type, week_number) from the current scoreboard."""
    sb = curl_json(sb_url())
    season = sb.get("season") or {}
    week = sb.get("week") or {}
    return season.get("year"), season.get("type"), week.get("number")


def write_archive(games: list[dict], meta: tuple, stamp: str, archive_dir: Path):
    """Persist this week's FINAL games (with raw stats) to
    <archive_dir>/<year>/<label>.json and refresh <archive_dir>/index.json.
    Only final games are archived; nothing is written if none are final."""
    year, stype, wk = meta
    if not (year and stype and wk):
        return
    finals = [g for g in games if g["meta"].get("state") == "post"]
    if not finals:
        return
    prefix = SEASON_TYPE_LABEL.get(stype, f"t{stype}")
    label = f"{prefix}-wk{int(wk):02d}"
    ydir = archive_dir / str(year)
    ydir.mkdir(parents=True, exist_ok=True)
    payload = {
        "season": year, "season_type": stype, "week": wk, "label": label,
        "title": week_title(stype, wk),
        "generated": stamp, "games": finals,
    }
    (ydir / f"{label}.json").write_text(json.dumps(payload, indent=1))
    _write_index(archive_dir)


def _write_index(archive_dir: Path):
    """Rebuild index.json listing every archived week, newest first."""
    weeks = []
    for p in sorted(archive_dir.glob("*/*.json")):
        if p.name == "index.json":
            continue
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        weeks.append({
            "season": d.get("season"), "season_type": d.get("season_type"),
            "week": d.get("week"), "label": d.get("label"),
            "title": week_title(d.get("season_type"), d.get("week")),
            "path": f"data/{p.parent.name}/{p.name}",
        })
    weeks.sort(key=lambda w: (w.get("season") or 0, w.get("season_type") or 0,
                              w.get("week") or 0), reverse=True)
    (archive_dir / "index.json").write_text(json.dumps({"weeks": weeks}, indent=1))


def collect(args) -> list[dict]:
    games = []
    if args.from_dir:
        for p in sorted(Path(args.from_dir).glob("*.json")):
            try:
                games.append(build_game(p))
            except Exception as e:
                print(f"  skip {p.name}: {e}", file=sys.stderr)
    else:
        tmp = Path(tempfile.gettempdir()) / "dadsffl_live"
        cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
        refetch = getattr(args, "refetch_finals", False)
        if args.game:
            pairs = [(args.game, False)]           # single game: always fetch fresh
        else:
            live, final, _pre = scoreboard_states()
            finals = set(final)
            pairs = [(g, g in finals) for g in (live + final)]
            if not pairs:
                print("No live/finished games found on the ESPN scoreboard right now.")
        n_fetch = n_cache = 0
        for gid, is_final in pairs:
            p, from_cache = None, False
            # A final game's box score is stable — serve it from the persisted
            # cache and DON'T re-hit ESPN, unless --refetch-finals (Tuesday final).
            if is_final and cache_dir and not refetch:
                cached = cache_dir / f"{gid}.json"
                if cached.exists():
                    p, from_cache = cached, True
            if p is None:
                dest = cache_dir if (is_final and cache_dir) else tmp
                p = fetch_summary_to_file(gid, dest)   # writes/overwrites the cache for finals
            if p:
                games.append(build_game(p))
                n_cache += from_cache
                n_fetch += (not from_cache)
            else:
                print(f"  could not fetch game {gid} (no internet from here?)", file=sys.stderr)
        if pairs:
            print(f"  ({n_fetch} fetched from ESPN, {n_cache} served from cache)",
                  file=sys.stderr)
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
    ap.add_argument("--require-games", action="store_true",
                    help="publish only if a game is in progress or final on the "
                         "scoreboard; if nothing is live/final, do NOT write the "
                         "output (so a CI job can skip the deploy). Ignored with "
                         "--from-dir.")
    ap.add_argument("--cache-dir",
                    help="persist final games' box scores here and serve them from "
                         "cache instead of re-fetching ESPN. Live games are always "
                         "fetched fresh. In CI, back this with actions/cache.")
    ap.add_argument("--refetch-finals", action="store_true",
                    help="ignore the finals cache and re-fetch every game fresh "
                         "(the Tuesday-noon final run, to catch stat corrections).")
    ap.add_argument("--archive-dir",
                    help="also write each week's FINAL games (with raw stats) to "
                         "<dir>/<year>/<label>.json + <dir>/index.json, for a "
                         "durable history and DB ingest. Ignored with --from-dir.")
    ap.add_argument("--week", type=int,
                    help="target a SPECIFIC past week for backfill (with --seasontype).")
    ap.add_argument("--seasontype", type=int, choices=(1, 2, 3),
                    help="1=preseason, 2=regular, 3=post. Use with --week to backfill.")
    args = ap.parse_args()

    global SB_QUERY
    if args.week and args.seasontype:
        SB_QUERY = f"?seasontype={args.seasontype}&week={args.week}"

    refresh = args.refresh if args.refresh is not None else (args.watch or 0)
    out = Path(args.out)

    def once():
        # e.g. "Wed, Aug 19 · 3:48:14 PM EDT" — date + tz so it's unambiguous
        stamp = time.strftime("%a, %b %-d · %-I:%M:%S %p %Z")
        if args.require_games and not args.from_dir:
            live, final, _pre = scoreboard_states()
            if not (live or final):
                print(f"[{stamp}] no games in progress or final — skipping "
                      f"publish (--require-games); leaving {out.name} untouched.")
                return
        games = collect(args)
        adir = (Path(args.archive_dir)
                if (getattr(args, "archive_dir", None) and not args.from_dir) else None)
        if adir:
            try:
                write_archive(games, scoreboard_meta(), stamp, adir)   # updates index.json first
            except Exception as e:
                print(f"  archive step failed: {e}", file=sys.stderr)
        render_site(games, out, refresh, stamp, adir)
        n_scored = sum(1 for g in games for v in g["players"].values() for p in v if p["scored"])
        n_all = sum(len(v) for g in games for v in g["players"].values())
        print(f"[{stamp}] wrote {out} — {len(games)} games, "
              f"{n_scored} scoring / {n_all} total players")

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
