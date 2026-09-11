// DadsFFL fetch-and-score Edge Function.
// Ports the orchestration from src/live_score.py's collect()/build_game()/
// game_meta() — fetch ESPN scoreboard + box scores, parse + score every
// player, upsert into Postgres. Triggered by pg_cron (game-window polling,
// replacing GitHub Actions' unreliable `schedule:` trigger) or by the live
// page's refresh button (rate-limited here, server-side).
//
// Runs on Supabase's own infrastructure, not the dev sandbox that can't reach
// ESPN — this function's `fetch()` calls hit ESPN directly.
//
// LIVE-TESTED 2026-09-09 against the real NE @ SEA season opener (in-progress
// game rendered correctly on the live page). The scoring engine and parser
// this imports were verified against the real Python originals (176 scoring
// test cases, an 8-player synthetic ESPN fixture) — see project docs.
//
// 2026-09-10 — PERFORMANCE REWRITE of the write path. The previous version
// issued ~3 round trips PER PLAYER (upsert player, upsert stat line, delete +
// insert field goals) — roughly 500-900 round trips per game, ~15-20s/game —
// and died with `546 WORKER_RESOURCE_LIMIT` after about six games. Because
// every invocation walked the slate in the same order, the tail of a 10-14
// game Sunday would never have been updated at all. Now:
//   * players / stat_lines / field_goals are written as MULTI-ROW statements
//     (a handful of round trips per game instead of hundreds), and
//   * ESPN box scores are fetched a wave at a time in parallel rather than
//     strictly one after another, so network latency overlaps.
// Waves are kept small deliberately: it bounds peak memory (each summary is
// several hundred KB of JSON) while still overlapping the fetches.

import { Pool } from "jsr:@db/postgres@^0";
import { parseBoxScore, type EspnSummary, type ParsedStatLine } from "./espn_parser.ts";
import { scoreStatLine, scoreFgYards } from "./scoring_engine.ts";
import { inferPos, statSummary, weekTitle, SEASON_TYPE_LABEL } from "./format.ts";

const SUMMARY_URL = (id: string) =>
  `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`;
const SCOREBOARD_URL = "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

const RATE_LIMIT_SECONDS = 300; // 5 min — applies to the 'button' trigger only
const FETCH_TIMEOUT_MS = 20_000;

// How many ESPN box scores to fetch concurrently. Small on purpose: enough to
// hide latency, not enough to hold a whole Sunday's JSON in memory at once.
const FETCH_WAVE = 4;

// Multi-row batch sizes. Postgres caps a statement at 65,535 bound parameters;
// these stay far under it (stat_lines is the widest at 26 params/row).
const PLAYER_BATCH = 200; //  4 params/row
const STAT_BATCH = 80; // 26 params/row
const FG_BATCH = 300; //  3 params/row
const DELETE_BATCH = 500; //  1 param/row

const pool = new Pool(Deno.env.get("SUPABASE_DB_URL")!, 3, true);

// ---- small helpers ------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// "($1,$2,$3),($4,$5,$6)" — optionally with a literal suffix per row, e.g.
// placeholders(2, 2, "now()") => "($1,$2,now()),($3,$4,now())".
function placeholders(rowCount: number, colCount: number, suffix?: string): string {
  const rows: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push("$" + p++);
    if (suffix) cols.push(suffix);
    rows.push("(" + cols.join(",") + ")");
  }
  return rows.join(",");
}

// ---- ESPN fetch --------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface ScoreboardEvent {
  id: string;
  status?: { type?: { state?: string } };
}
interface ScoreboardResponse {
  events?: ScoreboardEvent[];
  season?: { year?: number; type?: number };
  week?: { number?: number };
}

async function scoreboardStates(query = ""): Promise<{
  live: string[];
  final: string[];
  pre: string[];
  meta: ScoreboardResponse;
}> {
  const sb = (await fetchJson<ScoreboardResponse>(SCOREBOARD_URL + query)) ?? {};
  const live: string[] = [], final: string[] = [], pre: string[] = [];
  for (const ev of sb.events ?? []) {
    const state = ev.status?.type?.state;
    if (state === "in") live.push(ev.id);
    else if (state === "post") final.push(ev.id);
    else if (state === "pre") pre.push(ev.id);
  }
  return { live, final, pre, meta: sb };
}

interface GameMeta {
  state: string;
  statusDetail: string;
  home: { abbrev: string; name: string; score: string };
  away: { abbrev: string; name: string; score: string };
}

function gameMeta(data: EspnSummary & Record<string, any>): GameMeta {
  const comp = data?.header?.competitions?.[0] ?? {};
  const status = comp.status ?? data?.header?.status ?? {};
  const st = status.type ?? {};
  const teams: Record<string, { abbrev: string; name: string; score: string }> = {};
  for (const c of comp.competitors ?? []) {
    const t = c.team ?? {};
    teams[c.homeAway ?? "?"] = {
      abbrev: t.abbreviation ?? "?",
      name: t.shortDisplayName ?? t.name ?? "?",
      score: c.score ?? "",
    };
  }
  return {
    state: st.state ?? "?",
    statusDetail: st.shortDetail ?? st.detail ?? st.description ?? "",
    home: teams.home ?? { abbrev: "?", name: "?", score: "" },
    away: teams.away ?? { abbrev: "?", name: "?", score: "" },
  };
}

// ---- DB helpers ---------------------------------------------------------

async function resolveWeekId(
  conn: any,
  meta: ScoreboardResponse,
): Promise<number | null> {
  const year = meta.season?.year;
  const seasonType = meta.season?.type;
  const weekNumber = meta.week?.number;
  if (!year || !seasonType || !weekNumber) return null;

  const seasonRow = await conn.queryObject<{ id: number }>(
    `insert into seasons (year) values ($1)
     on conflict (year) do update set year = excluded.year
     returning id`,
    [year],
  );
  const seasonId = seasonRow.rows[0].id;

  const label = `${SEASON_TYPE_LABEL[seasonType] ?? `t${seasonType}`}-wk${
    String(weekNumber).padStart(2, "0")
  }`;
  const title = weekTitle(seasonType, weekNumber);

  const weekRow = await conn.queryObject<{ id: number }>(
    `insert into weeks (season_id, season_type, week_number, label, title)
     values ($1, $2, $3, $4, $5)
     on conflict (label) do update set title = excluded.title
     returning id`,
    [seasonId, seasonType, weekNumber, label, title],
  );
  return weekRow.rows[0].id;
}

async function upsertGame(
  conn: any,
  gameId: string,
  weekId: number | null,
  meta: GameMeta,
): Promise<void> {
  await conn.queryObject(
    `insert into games (id, week_id, home_abbrev, home_name, home_score,
                         away_abbrev, away_name, away_score, state, status_detail, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     on conflict (id) do update set
       week_id = excluded.week_id, home_abbrev = excluded.home_abbrev,
       home_name = excluded.home_name, home_score = excluded.home_score,
       away_abbrev = excluded.away_abbrev, away_name = excluded.away_name,
       away_score = excluded.away_score, state = excluded.state,
       status_detail = excluded.status_detail, updated_at = now()`,
    [
      gameId, weekId, meta.home.abbrev, meta.home.name, meta.home.score,
      meta.away.abbrev, meta.away.name, meta.away.score, meta.state, meta.statusDetail,
    ],
  );
}

interface PlayerRow {
  espnAthleteId: string;
  name: string | undefined;
  nflTeam: string | undefined;
  inferredPosition: string;
}

// One multi-row upsert per batch instead of one statement per player.
// Returns espn_athlete_id -> players.id for everything written.
//
// Rows are deduplicated by espn_athlete_id first: Postgres rejects an
// `on conflict do update` whose VALUES list touches the same key twice
// ("cannot affect row a second time"), which a single-row loop never hit.
async function upsertPlayersBatch(
  conn: any,
  rows: PlayerRow[],
): Promise<Map<string, number>> {
  const byAthlete = new Map<string, PlayerRow>();
  for (const r of rows) {
    if (r.espnAthleteId) byAthlete.set(r.espnAthleteId, r);
  }
  const ids = new Map<string, number>();

  for (const batch of chunk([...byAthlete.values()], PLAYER_BATCH)) {
    const params: unknown[] = [];
    for (const r of batch) {
      params.push(r.espnAthleteId, r.name ?? "", r.nflTeam ?? null, r.inferredPosition);
    }
    const res = await conn.queryObject<{ id: number; espn_athlete_id: string }>(
      `insert into players (espn_athlete_id, name, nfl_team, inferred_position)
       values ${placeholders(batch.length, 4)}
       on conflict (espn_athlete_id) do update
         set name = excluded.name, nfl_team = excluded.nfl_team,
             inferred_position = excluded.inferred_position
       returning id, espn_athlete_id`,
      params,
    );
    // Number() on purpose: these id columns are bigint, and the driver may hand
    // them back as BigInt (or a string). The old one-statement-per-row code fed
    // the value straight back as a bind parameter so its runtime type never
    // mattered; now it is a Map key, and BigInt(5) !== 5 would silently drop
    // every stat line.
    for (const row of res.rows) ids.set(row.espn_athlete_id, Number(row.id));
  }
  return ids;
}

interface StatRow {
  playerId: number;
  line: ParsedStatLine;
  fantasyPoints: number;
  summary: string;
}

// One multi-row upsert per batch instead of one statement per stat line.
// Returns players.id -> stat_lines.id so field goals can be attached.
// Deduplicated by player_id for the same reason as players above.
async function upsertStatLinesBatch(
  conn: any,
  gameId: string,
  rows: StatRow[],
): Promise<Map<number, number>> {
  const byPlayer = new Map<number, StatRow>();
  for (const r of rows) byPlayer.set(r.playerId, r);
  const ids = new Map<number, number>();

  for (const batch of chunk([...byPlayer.values()], STAT_BATCH)) {
    const params: unknown[] = [];
    for (const r of batch) {
      const l = r.line;
      params.push(
        gameId, r.playerId, l.pat_made, l.pass_yards, l.pass_td, l.rush_yards,
        l.rush_td, l.receptions, l.rec_yards, l.rec_td, l.def_td,
        l.fumble_td, l.return_td, l.two_pt_conv, l.sacks, l.interceptions,
        l.safeties, r.fantasyPoints, r.summary,
        l.pass_att, l.pass_cmp, l.pass_int, l.rush_att, l.targets,
        l.tackles_solo, l.tackles_assist,
      );
    }
    const res = await conn.queryObject<{ id: number; player_id: number }>(
      `insert into stat_lines (
         game_id, player_id, pat_made, pass_yards, pass_td, rush_yards, rush_td,
         receptions, rec_yards, rec_td, def_td, fumble_td, return_td, two_pt_conv,
         sacks, interceptions, safeties, fantasy_points, summary,
         pass_att, pass_cmp, pass_int, rush_att, targets, tackles_solo,
         tackles_assist, updated_at
       ) values ${placeholders(batch.length, 26, "now()")}
       on conflict (game_id, player_id) do update set
         pat_made=excluded.pat_made, pass_yards=excluded.pass_yards, pass_td=excluded.pass_td,
         rush_yards=excluded.rush_yards, rush_td=excluded.rush_td, receptions=excluded.receptions,
         rec_yards=excluded.rec_yards, rec_td=excluded.rec_td, def_td=excluded.def_td,
         fumble_td=excluded.fumble_td, return_td=excluded.return_td, two_pt_conv=excluded.two_pt_conv,
         sacks=excluded.sacks, interceptions=excluded.interceptions, safeties=excluded.safeties,
         fantasy_points=excluded.fantasy_points, summary=excluded.summary,
         pass_att=excluded.pass_att, pass_cmp=excluded.pass_cmp, pass_int=excluded.pass_int,
         rush_att=excluded.rush_att, targets=excluded.targets,
         tackles_solo=excluded.tackles_solo, tackles_assist=excluded.tackles_assist,
         updated_at=now()
       returning id, player_id`,
      params,
    );
    for (const row of res.rows) ids.set(Number(row.player_id), Number(row.id));
  }
  return ids;
}

// Field goals are stored as one row per kick, so they are replaced rather than
// upserted: delete every FG row for this game's stat lines, then insert the
// current set. Both halves are batched — previously this was a DELETE plus one
// INSERT per made field goal, per player, for every player in the game.
async function replaceFieldGoalsBatch(
  conn: any,
  entries: { statLineId: number; fgYards: number[] }[],
): Promise<void> {
  const statLineIds = [...new Set(entries.map((e) => e.statLineId))];
  if (!statLineIds.length) return;

  for (const batch of chunk(statLineIds, DELETE_BATCH)) {
    await conn.queryObject(
      `delete from field_goals where stat_line_id in (${
        batch.map((_, i) => "$" + (i + 1)).join(",")
      })`,
      batch,
    );
  }

  const fgRows: { statLineId: number; yards: number }[] = [];
  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.statLineId)) continue;
    seen.add(e.statLineId);
    for (const yards of e.fgYards ?? []) fgRows.push({ statLineId: e.statLineId, yards });
  }
  if (!fgRows.length) return;

  for (const batch of chunk(fgRows, FG_BATCH)) {
    const params: unknown[] = [];
    for (const r of batch) params.push(r.statLineId, r.yards, scoreFgYards(r.yards));
    await conn.queryObject(
      `insert into field_goals (stat_line_id, yards, points)
       values ${placeholders(batch.length, 3)}`,
      params,
    );
  }
}

// ---- main -----------------------------------------------------------------

type Trigger = "cron" | "button" | "manual";

// The dadsffl-live page calls this function directly from the browser (the
// refresh button), which means the browser sends a CORS preflight OPTIONS
// request first. Edge Functions don't add CORS headers automatically, so
// without this the button's fetch() fails with an opaque "Failed to fetch"
// before our code ever runs. pg_cron's server-side calls don't need this
// (no browser, no preflight) but it's harmless for them either way.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let trigger: Trigger = "manual";
  // Optional one-off BACKFILL: POST {"scoreboard":{"year":2026,"seasontype":1,"week":2}}
  // to poll a PAST week's scoreboard instead of the current one. Everything
  // downstream (fetch box score, parse, score, upsert) is identical to a live run.
  let sbQuery = "";
  let sbOffset = 0;
  let sbCount = 0;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.trigger === "cron" || body?.trigger === "button") trigger = body.trigger;
    const sb = body?.scoreboard;
    // offset/count work with or without a past-week selector, so a big slate can
    // be split across several invocations (each gets its own compute budget).
    // With the batched writes below a full slate fits in one invocation, so this
    // is now a safety valve rather than the primary mechanism.
    sbOffset = Number(body?.offset ?? sb?.offset) || 0;
    sbCount = Number(body?.count ?? sb?.count) || 0;
    if (sb && sb.year && sb.seasontype && sb.week) {
      sbQuery = "?limit=1000&dates=" + Number(sb.year) +
        "&seasontype=" + Number(sb.seasontype) + "&week=" + Number(sb.week);
    }
  } catch {
    // no body / not JSON -- default manual
  }

  const startedAt = Date.now();
  const conn = await pool.connect();
  try {
    if (trigger === "button") {
      const last = await conn.queryObject<{ started_at: string }>(
        `select started_at from live_score_runs order by started_at desc limit 1`,
      );
      if (last.rows.length) {
        const ageMs = Date.now() - new Date(last.rows[0].started_at).getTime();
        if (ageMs < RATE_LIMIT_SECONDS * 1000) {
          const retryAfter = Math.ceil((RATE_LIMIT_SECONDS * 1000 - ageMs) / 1000);
          return Response.json(
            { error: "too soon", retry_after_seconds: retryAfter },
            {
              status: 429,
              headers: { ...corsHeaders, "Retry-After": String(retryAfter) },
            },
          );
        }
      }
    }

    const runRow = await conn.queryObject<{ id: number }>(
      `insert into live_score_runs (trigger) values ($1) returning id`,
      [trigger],
    );
    const runId = runRow.rows[0].id;

    const { live, final, meta } = await scoreboardStates(sbQuery);
    let gameIds = [...live, ...final];
    // Process only a slice of the slate per invocation when asked to. No longer
    // needed for a normal slate (see the batching note at the top of the file),
    // but kept for backfills and as an escape hatch.
    if (sbCount) gameIds = gameIds.slice(sbOffset, sbOffset + sbCount);
    const weekId = await resolveWeekId(conn, meta);

    let playersScored = 0;
    let playersTotal = 0;
    let gamesWritten = 0;

    // Fetch a wave of box scores in parallel, then write them. Writes stay
    // sequential (one pooled connection) but are only a handful of statements
    // per game now, so the slate is dominated by the overlapped fetches.
    for (const wave of chunk(gameIds, FETCH_WAVE)) {
      const fetched = await Promise.all(
        wave.map(async (id) => [id, await fetchJson<EspnSummary>(SUMMARY_URL(id))] as const),
      );

      for (const [gameId, summary] of fetched) {
        if (!summary || !summary.boxscore) continue;

        const gMeta = gameMeta(summary);
        await upsertGame(conn, gameId, weekId, gMeta);

        const prepared = Object.values(parseBoxScore(summary, gameId)).map((line) => {
          const breakdown = scoreStatLine(line);
          return {
            line,
            inferredPosition: inferPos(line),
            summary: statSummary(line),
            fantasyPoints: Math.round(breakdown.total * 10) / 10,
            scoring: breakdown.total > 0,
          };
        });

        playersTotal += prepared.length;
        for (const p of prepared) if (p.scoring) playersScored++;

        const playerIds = await upsertPlayersBatch(
          conn,
          prepared.map((p) => ({
            espnAthleteId: p.line.athlete_id,
            name: p.line.name,
            nflTeam: p.line.team,
            inferredPosition: p.inferredPosition,
          })),
        );

        const statRows: StatRow[] = [];
        for (const p of prepared) {
          const playerId = playerIds.get(p.line.athlete_id);
          if (playerId == null) continue; // no player row -> nothing to hang a stat line on
          statRows.push({
            playerId,
            line: p.line,
            fantasyPoints: p.fantasyPoints,
            summary: p.summary,
          });
        }

        const statLineIds = await upsertStatLinesBatch(conn, gameId, statRows);

        const fgEntries: { statLineId: number; fgYards: number[] }[] = [];
        for (const r of statRows) {
          const statLineId = statLineIds.get(r.playerId);
          if (statLineId == null) continue;
          fgEntries.push({ statLineId, fgYards: r.line.fg_yards });
        }
        await replaceFieldGoalsBatch(conn, fgEntries);

        gamesWritten++;
      }
    }

    const elapsedMs = Date.now() - startedAt;
    await conn.queryObject(
      `update live_score_runs set finished_at = now(), games_polled = $1,
         note = $2 where id = $3`,
      [
        gameIds.length,
        `${playersScored}/${playersTotal} players scoring · ${gamesWritten}/${gameIds.length} games written · ${elapsedMs}ms`,
        runId,
      ],
    );

    return Response.json(
      {
        trigger,
        games_polled: gameIds.length,
        games_written: gamesWritten,
        players_scored: playersScored,
        players_total: playersTotal,
        elapsed_ms: elapsedMs,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return Response.json(
      { error: String(err) },
      { status: 500, headers: corsHeaders },
    );
  } finally {
    conn.release();
  }
}

export default { fetch: handleRequest };
