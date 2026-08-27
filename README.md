# DadsFFL — Live Scoring (hosted)

A tiny, stateless site that shows **every NFL player's fantasy points under the
DadsFFL scoring rules**, updated during games. GitHub Actions fetches the current
box scores from ESPN, runs them through our real parser + scoring engine, and
publishes the result to GitHub Pages. No database, no secrets, no personal league
data — just NFL player scoring, so this repo is safe to make **public** (which is
what makes Actions + Pages free).

The league scoreboard (team names, owners, matchups) lives elsewhere and is not
published here.

## What's in here

```
src/scoring_engine.py     the DadsFFL scoring rules (single source of truth)
src/espn_parser.py        raw ESPN box-score JSON -> per-player counting stats
src/live_score.py         fetch -> parse -> score -> render one HTML page
web/live.template.html    the self-contained display (light/dark, auto-refresh)
.github/workflows/live-scoring.yml   the automation
```

## One-time setup

1. **Create a new public repo** on GitHub named `dadsffl-live` (empty — no README).
2. **Push this folder** to it:
   ```bash
   cd dadsffl-live
   git init -b main
   git add .
   git commit -m "DadsFFL live scoring"
   git remote add origin git@github-fitz1j:fitz1j/dadsffl-live.git
   git push -u origin main
   ```
   (Or, if you install the GitHub CLI: `gh repo create dadsffl-live --public --source=. --push`.)
   > Note: the remote uses the `github-fitz1j` SSH alias (personal account, kept separate from work GitHub). One-time setup: generate `~/.ssh/id_ed25519_fitz1j`, add its `.pub` to the fitz1j account, and add a `Host github-fitz1j` block (HostName github.com, that IdentityFile, IdentitiesOnly yes) to `~/.ssh/config`. Test with `ssh -T git@github-fitz1j`.
3. **Turn on Pages via Actions:** repo **Settings → Pages → Build and deployment →
   Source = GitHub Actions**.
4. That's it. The workflow runs on every push, on a game-day schedule, and on
   demand. Your live page will be at:
   `https://fitz1j.github.io/dadsffl-live/`

## Run it now (don't wait for the schedule)

Repo **Actions** tab → **DadsFFL live scoring** → **Run workflow**. In ~30–60s the
Pages URL shows the current games. During preseason, if no games are live it will
say so; point it at a game window and refresh.

## Tuning the update cadence

- The schedule is in `.github/workflows/live-scoring.yml`. `*/5 * * * 0,1,4,6`
  runs every 5 minutes on Sun/Mon/Thu/Sat. Cron is **UTC** and best-effort.
- The published page also reloads itself every 120s (`--refresh 120`) so an open
  browser picks up each new deploy without a manual refresh.
- GitHub disables scheduled workflows after 60 days of no repo activity — a single
  commit re-arms them.

## Local use (unchanged)

You can still run it on your Mac against live or stored games:
```bash
cd src
python3 live_score.py --live --watch 30      # then open ../web/live.html
python3 live_score.py --game <espn_event_id>
python3 live_score.py --from-dir <folder-of-raw-json>   # offline
```
