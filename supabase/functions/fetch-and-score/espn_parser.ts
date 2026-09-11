// Parse a raw ESPN box score JSON (site.api.espn.com .../summary?event=) into
// one raw stat-line dict per player. Ported 1:1 from src/espn_parser.py
// (dadsffl-live repo, commit as of 2026-09-01) — keep both in lock step.
//
// Key data-quality finding this parser accounts for: ESPN's 'defensive'
// statistics category TD column is a TOTAL of that player's defensive
// touchdowns, and ALREADY INCLUDES interception-return and fumble-return
// scores. The 'interceptions' category also has its own TD column for the
// same play. Naively summing both would double-count a pick-six. This parser
// uses 'defensive'.TD as the sole source for def_td and does NOT add
// 'interceptions'.TD on top of it.
//
// Two fields are NOT available as structured per-player columns anywhere in
// this endpoint and are recovered from `scoringPlays[].text` instead:
//   - Field goal distance (the 'kicking' category only gives aggregate
//     makes/attempts, not each kick's distance)
//   - Two-point conversions (embedded as a parenthetical suffix on the TD
//     scoring play's text)
//
// CAVEATS (flagging honestly, same as the Python original):
//   - No fixture with a safety has been seen — that detection is untested
//     against a real example.
//   - No fixture with a successful two-point RUN conversion has been seen —
//     that pattern is a best guess, not verified.
//   - Name-matching regexes below use JS's ASCII-only `\w`, unlike Python's
//     Unicode-aware `\w` — a display name with a diacritic (e.g. an accented
//     character) could fail to match where the Python version would. Not yet
//     hit in practice; worth revisiting if a scoring play for such a player
//     is ever missed.
//   Both should be re-checked against real examples before fully trusting them.

export interface ParsedStatLine {
  athlete_id: string;
  name: string | undefined;
  team: string | undefined;
  event_id: string;
  pat_made: number;
  fg_yards: number[];
  pass_yards: number;
  pass_td: number;
  rush_yards: number;
  rush_td: number;
  receptions: number;
  rec_yards: number;
  rec_td: number;
  def_td: number;
  fumble_td: number;
  return_td: number;
  two_pt_conv: number;
  sacks: number;
  interceptions: number;
  safeties: number;
  pass_att: number;
  pass_cmp: number;
  pass_int: number;
  rush_att: number;
  targets: number;
  tackles_solo: number;
  tackles_assist: number;
}

type MutableLine = Omit<ParsedStatLine, "name" | "team" | "event_id">;

function blankStatLine(): MutableLine {
  return {
    athlete_id: "",
    pat_made: 0,
    fg_yards: [],
    pass_yards: 0,
    pass_td: 0,
    rush_yards: 0,
    rush_td: 0,
    receptions: 0,
    rec_yards: 0,
    rec_td: 0,
    def_td: 0,
    fumble_td: 0,
    return_td: 0,
    two_pt_conv: 0,
    sacks: 0,
    interceptions: 0,
    safeties: 0,
    pass_att: 0,
    pass_cmp: 0,
    pass_int: 0,
    rush_att: 0,
    targets: 0,
    tackles_solo: 0,
    tackles_assist: 0,
  };
}

// NOTE: no end-anchor. ESPN sometimes emits the FG scoring-play text with a
// trailing space (e.g. "Chris Boswell 60 Yd Field Goal "), and anchoring to
// end-of-string silently dropped those kicks. Gating on play type "Field Goal
// Good" already guarantees this is a made FG, so matching the leading part
// is safe.
const FG_GOOD_RE = /^(?<kicker>.+?) (?<yards>\d+) Yd Field Goal/;

// Two-point conversions are emitted as a PARENTHETICAL on the touchdown
// scoring play, e.g. "... (Brock Purdy Pass to Jauan Jennings for Two-Point
// Conversion)". We extract each parenthetical's contents and parse THAT,
// rather than anchoring to the start of the whole play text.
const PAREN_RE = /\(([^()]*)\)/g;
const TWO_PT_PASS_RE = /^(?<passer>.+?) Pass to (?<receiver>.+?) for Two-Point Conversion$/;
const TWO_PT_RUN_RE = /^(?<rusher>.+?) Run for Two-Point Conversion$/;

// deno-lint-ignore no-unused-vars -- ported for parity with the Python source, unused there too
const SAFETY_RE = /\bSafety\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toInt(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

function toFloat(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? 0 : n;
}

function splitMadeAttempts(s: string | undefined): [number, number] {
  if (!s) return [0, 0];
  const parts = s.split("/");
  if (parts.length !== 2) return [0, 0];
  const made = parseInt(parts[0], 10);
  const att = parseInt(parts[1], 10);
  if (Number.isNaN(made) || Number.isNaN(att)) return [0, 0];
  return [made, att];
}

function findAthleteIdByName(names: Map<string, string>, displayName: string): string | null {
  const target = displayName.trim();
  for (const [aid, n] of names) {
    if (n === target) return aid;
  }
  return null;
}

// Minimal shape of the ESPN summary JSON this parser reads. Fields beyond
// these are ignored.
export interface EspnSummary {
  header?: { id?: string };
  boxscore?: {
    players?: Array<{
      team?: { abbreviation?: string };
      statistics?: Array<{
        name?: string;
        labels?: string[];
        athletes?: Array<{
          athlete?: { id?: string; displayName?: string };
          stats?: string[];
        }>;
      }>;
    }>;
  };
  scoringPlays?: Array<{
    type?: { text?: string };
    text?: string;
  }>;
}

/** Returns a map keyed by ESPN athlete id -> parsed stat line. */
export function parseBoxScore(
  data: EspnSummary,
  eventIdFallback: string,
): Record<string, ParsedStatLine> {
  const eventId = data.header?.id || eventIdFallback;

  const statsByAthlete = new Map<string, MutableLine>();
  const names = new Map<string, string>();
  const teams = new Map<string, string>();
  const defensiveIds = new Set<string>(); // athletes appearing in the 'defensive' category

  const lineFor = (aid: string): MutableLine => {
    let line = statsByAthlete.get(aid);
    if (!line) {
      line = blankStatLine();
      line.athlete_id = aid;
      statsByAthlete.set(aid, line);
    }
    return line;
  };

  for (const teamBlock of data.boxscore?.players ?? []) {
    const teamAbbr = teamBlock.team?.abbreviation ?? "";
    for (const category of teamBlock.statistics ?? []) {
      const catName = category.name;
      const labels = category.labels ?? [];
      for (const entry of category.athletes ?? []) {
        const athlete = entry.athlete;
        if (!athlete?.id) continue;
        const aid = athlete.id;
        names.set(aid, athlete.displayName ?? "");
        teams.set(aid, teamAbbr);
        const statMap = new Map<string, string>();
        labels.forEach((label, i) => statMap.set(label, entry.stats?.[i] ?? ""));
        const line = lineFor(aid);

        if (catName === "passing") {
          line.pass_yards += toInt(statMap.get("YDS"));
          line.pass_td += toInt(statMap.get("TD"));
          const ca = String(statMap.get("C/ATT") || "0/0").split("/");
          line.pass_cmp += toInt(ca[0]);
          line.pass_att += toInt(ca[1]);
          line.pass_int += toInt(statMap.get("INT"));
        } else if (catName === "rushing") {
          line.rush_yards += toInt(statMap.get("YDS"));
          line.rush_td += toInt(statMap.get("TD"));
          line.rush_att += toInt(statMap.get("CAR"));
        } else if (catName === "receiving") {
          line.receptions += toInt(statMap.get("REC"));
          line.rec_yards += toInt(statMap.get("YDS"));
          line.rec_td += toInt(statMap.get("TD"));
          line.targets += toInt(statMap.get("TGTS"));
        } else if (catName === "defensive") {
          line.def_td += toInt(statMap.get("TD"));
          line.sacks += toFloat(statMap.get("SACKS"));
          const solo = toInt(statMap.get("SOLO"));
          const tot = toInt(statMap.get("TOT"));
          line.tackles_solo += solo;
          line.tackles_assist += Math.max(0, tot - solo);
          defensiveIds.add(aid);
        } else if (catName === "interceptions") {
          // INT count only — do NOT add this category's TD column, it
          // duplicates 'defensive'.TD for the same pick-six.
          line.interceptions += toInt(statMap.get("INT"));
        } else if (catName === "kickReturns" || catName === "puntReturns") {
          line.return_td += toInt(statMap.get("TD"));
        } else if (catName === "kicking") {
          const [made] = splitMadeAttempts(statMap.get("XP") ?? "0/0");
          line.pat_made += made;
          // FG makes counted here for a sanity check only; bucketed
          // distances come from scoringPlays below.
        }
      }
    }
  }

  // Field goal distances + two-point conversions: recovered from scoringPlays text.
  for (const play of data.scoringPlays ?? []) {
    const playType = play.type?.text ?? "";
    const text = play.text ?? "";

    if (playType === "Field Goal Good") {
      const m = FG_GOOD_RE.exec(text);
      if (m?.groups) {
        const kickerName = m.groups.kicker;
        const yards = parseInt(m.groups.yards, 10);
        const aid = findAthleteIdByName(names, kickerName);
        if (aid) lineFor(aid).fg_yards.push(yards);
      }
    }

    // Offensive fumble-recovery touchdowns (e.g. an RB falling on his QB's
    // fumble in the end zone) don't appear in rushing/receiving OR defensive
    // stat categories, so they must come from scoringPlays. Only credit
    // players NOT in the 'defensive' category — defensive fumble-return TDs
    // are already counted via def_td (avoids double-count).
    if (playType === "Fumble Return Touchdown") {
      for (const [aid, nm] of names) {
        if (defensiveIds.has(aid)) continue;
        if (!nm) continue;
        const pat = new RegExp(
          escapeRegExp(nm) +
            "(?: \\d+ Yd Fumble (?:Recovery|Return)" +
            "| Fumble Recovery in End Zone" +
            "| Recovered Kickoff in End Zone)",
        );
        if (pat.test(text)) {
          lineFor(aid).fumble_td += 1;
          break;
        }
      }
    }

    if (playType === "Safety") {
      // Credit the individual defender who caused the safety. Two forms:
      //   "... Sacked by <Player> For N Yd Loss for Safety" -> the sacker
      //   "<Player> Safety"                                  -> that player
      // Team/penalty safeties ("Team Safety", "... Holding ... for Safety")
      // have no individual to credit and are skipped.
      let m = /Sacked by (?<p>.+?) For /.exec(text);
      if (!m) {
        m = /^(?<p>[A-Z][\w.'-]+(?: [A-Z][\w.'-]+)+) Safety$/.exec(text);
      }
      if (m?.groups) {
        const who = m.groups.p.trim();
        if (who !== "Team") {
          const aid = findAthleteIdByName(names, who);
          if (aid) lineFor(aid).safeties += 1;
        }
      }
    }

    // Two-point conversions live inside a parenthetical on the TD play.
    // Parse each parenthetical independently so passer/receiver names are
    // clean (not the whole pre-paren prefix).
    for (const match of text.matchAll(PAREN_RE)) {
      const inner = (match[1] ?? "").trim();
      if (!inner.includes("Two-Point") || !inner.includes("Conversion")) continue;

      if (inner.includes("Failed")) {
        // A defender who intercepts/returns a FAILED two-point conversion
        // scores 2 in this league. e.g. "Two-Point Pass Conversion Failed.
        // Minkah Fitzpatrick Interception Return". Counted in two_pt_conv.
        // Otherwise no points for a fail.
        const md = /Conversion Failed\.?\s*(?<p>[A-Z][\w.'-]+(?: [A-Z][\w.'-]+)+) (?:Interception|Fumble) Return/.exec(
          inner,
        );
        if (md?.groups) {
          const aid = findAthleteIdByName(names, md.groups.p.trim());
          if (aid) lineFor(aid).two_pt_conv += 1;
        }
        continue;
      }

      const mp = TWO_PT_PASS_RE.exec(inner);
      if (mp?.groups) {
        for (const who of [mp.groups.passer, mp.groups.receiver]) {
          const aid = findAthleteIdByName(names, who.trim());
          if (aid) lineFor(aid).two_pt_conv += 1;
        }
        continue;
      }

      const mr = TWO_PT_RUN_RE.exec(inner);
      if (mr?.groups) {
        const aid = findAthleteIdByName(names, mr.groups.rusher.trim());
        if (aid) lineFor(aid).two_pt_conv += 1;
      }
    }
  }

  const result: Record<string, ParsedStatLine> = {};
  for (const [aid, line] of statsByAthlete) {
    result[aid] = {
      ...line,
      name: names.get(aid),
      team: teams.get(aid),
      event_id: eventId,
    };
  }
  return result;
}
