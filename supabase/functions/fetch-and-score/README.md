# `fetch-and-score` Edge Function

Polls the ESPN scoreboard, fetches each box score, scores every player under
DadsFFL rules, and upserts the results into the Supabase Postgres database that
`web/live.html` reads. Invoked by `pg_cron` during game windows and by the live
page's Refresh button (rate-limited server-side).

## Source of truth — read this before editing

These files are a **copy of what is deployed**. The deployed function lives in
the Supabase dashboard (Edge Functions → `fetch-and-score` → Code), and that
dashboard copy is still what actually runs. Nothing here deploys automatically.

So: edit in the dashboard, deploy there, then update these files to match. The
copies were verified identical to the deployed versions when committed (see the
checksums below).

## Files

| file | role |
|---|---|
| `index.ts` | Orchestration: ESPN fetch → parse → score → batched upserts, CORS, the button rate-limit gate. No Python counterpart. |
| `espn_parser.ts` | 1:1 port of `src/espn_parser.py` |
| `scoring_engine.ts` | 1:1 port of `src/scoring_engine.py` |
| `format.ts` | Port of the display helpers in `src/live_score.py` (`infer_pos`, `stat_summary`, `week_title`) |

**The three ports must change in lockstep with their Python originals** — the
Python is used by the local runner and for validation, and the two are expected
to score identically. `index.ts` is orchestration only, so it has no such
constraint.

## Request body

All fields optional; a bare `POST` with no body behaves as `manual`.

```jsonc
{
  "trigger": "cron" | "button",          // "button" is rate-limited to 1 run / 5 min
  "scoreboard": {                        // backfill a PAST week instead of the current one
    "year": 2026, "seasontype": 1, "week": 4
  },
  "offset": 0, "count": 5                // process only a slice of the slate
}
```

`offset`/`count` exist as an escape hatch. They are no longer needed for a
normal slate: since the writes were batched (2026-09-11) a full 16-game week
completes in one invocation in ~14s, where it previously died with
`546 WORKER_RESOURCE_LIMIT` after about six games.

## Gotchas worth knowing before you touch the write path

- **ESPN blocks `site.api.espn.com` from Supabase's egress** (HTTP 403, IP-level).
  Use `site.web.api.espn.com` — identical paths and JSON. `cdn.espn.com` and
  `sports.core.api.espn.com` also work. The Python runs from a laptop, so it is
  unaffected and still uses the original host.
- **`on conflict do update` rejects a VALUES list that touches the same key
  twice** ("cannot affect row a second time"). Batched rows are deduplicated by
  `espn_athlete_id` / `(game_id, player_id)` first. A one-row-at-a-time loop
  never hits this.
- **The `bigint` ids are Map keys now, not just bind parameters.** The driver may
  return them as `BigInt` or a string, and `BigInt(5) !== 5` would silently drop
  every stat line, so anything id-shaped is wrapped in `Number()`.
- **PostgREST silently caps responses at 1000 rows.** That bites the *reader*
  (`web/live.html` pages the query), not this function, but it is the same class
  of failure: truncation with no error.

## Deployed-copy checksums (sha256, at time of commit)

```
3a65191e0aef29d284537899b659c93c5596f7fab133554ff061acfa66e57fba  index.ts
aee9ffceb30417b3d68f117df0796b71c5362301fab8c605b42cc36fdb92f218  espn_parser.ts
0e6b19e3ddca5b5eebe5633a0401a2a66f626d97aa4ba2e8e2aa5fce6c385c6c  scoring_engine.ts
0a350e32f5392915569c2b92ec3c77b54f27f0016344ac4077d4653eabbe1bfd  format.ts
```
