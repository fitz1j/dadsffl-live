// Small display/labeling helpers ported from live_score.py (infer_pos,
// stat_summary, week_title, SEASON_TYPE_LABEL).

import type { ParsedStatLine } from "./espn_parser.ts";

export const SEASON_TYPE_LABEL: Record<number, string> = { 1: "pre", 2: "reg", 3: "post" };

/** Human label for a week. ESPN files the Hall of Fame Game as preseason
 * week 1, so preseason week N>1 displays as "Pre Week N-1". */
export function weekTitle(seasonType: number | undefined, week: number | undefined): string {
  if (week === undefined || week === null || Number.isNaN(week)) return "Week";
  if (seasonType === 1) return week === 1 ? "Hall of Fame" : `Pre Week ${week - 1}`;
  if (seasonType === 3) return `Post Week ${week}`;
  return `Week ${week}`;
}

/** Rough position guess from raw stats — no roster context in preseason /
 * before fantasy lineups map players to real roster positions (Phase 3). */
export function inferPos(s: ParsedStatLine): string {
  if (s.fg_yards.length || s.pat_made) return "K";
  if (s.sacks || s.interceptions || s.def_td || s.safeties) return "DEF";
  if (s.return_td) return "RET";
  if (s.pass_yards || s.pass_td || s.pass_att) return "QB";
  if (s.rush_yards >= s.rec_yards && s.rush_yards) return "RB";
  if (s.rec_yards || s.receptions || s.targets) return "WR";
  // Tackles alone are checked LAST: offensive players pick up the occasional
  // tackle (e.g. a QB after his own interception) and should not read as DEF.
  if (s.tackles_solo || s.tackles_assist) return "DEF";
  return "—";
}

// One-line display summary. Includes stats that SCORE and stats that do not
// (att/cmp, INTs thrown, carries, targets, tackles) -- the league wants the
// full line shown even where it earns nothing.
export function statSummary(s: ParsedStatLine): string {
  const parts: string[] = [];
  if (s.pass_yards || s.pass_td || s.pass_att) {
    let seg = s.pass_att ? s.pass_cmp + "/" + s.pass_att + ", " : "";
    seg += s.pass_yards + " pass yd";
    if (s.pass_td) seg += ", " + s.pass_td + " TD";
    if (s.pass_int) seg += ", " + s.pass_int + " INT";
    parts.push(seg);
  }
  if (s.rush_yards || s.rush_td || s.rush_att) {
    let seg = s.rush_att ? s.rush_att + " car, " : "";
    seg += s.rush_yards + " rush yd";
    if (s.rush_td) seg += ", " + s.rush_td + " TD";
    parts.push(seg);
  }
  if (s.receptions || s.rec_yards || s.rec_td || s.targets) {
    let seg = s.targets ? s.receptions + "/" + s.targets + " rec"
                        : s.receptions + " rec";
    seg += ", " + s.rec_yards + " yd";
    if (s.rec_td) seg += ", " + s.rec_td + " TD";
    parts.push(seg);
  }
  if (s.fg_yards.length) parts.push("FG " + s.fg_yards.join(", "));
  if (s.pat_made) parts.push(s.pat_made + " XP");
  // IDP line: solo tackles - assists - sacks (sacks also score).
  if (s.tackles_solo || s.tackles_assist || s.sacks) {
    parts.push("IDP " + s.tackles_solo + "-" + s.tackles_assist + "-" + s.sacks);
  }
  if (s.interceptions) parts.push(s.interceptions + " INT");
  if (s.def_td || s.fumble_td) parts.push(((s.def_td || 0) + (s.fumble_td || 0)) + " def TD");
  if (s.return_td) parts.push(s.return_td + " ret TD");
  if (s.safeties) parts.push(s.safeties + " safety");
  if (s.two_pt_conv) parts.push(s.two_pt_conv + " 2pt");
  return parts.join(" · ");
}
