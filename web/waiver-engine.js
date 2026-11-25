// DadsFFL waiver wire engine — Rule Book III (Sep 2026).
// Pure functions, no DOM and no network, so the page (web/waivers.html) and the
// tests (test/waiver-engine.test.mjs) run exactly the same logic.

/* ---------------- names (same normalization as weekly.html) ---------------- */
const ALIASES = {
  "ken walker": "kenneth walker",
  "kenny gainwell": "kenneth gainwell",
  "quentin johnson": "quentin johnston",
  "omarion hamption": "omarion hampton",
  "tyler allegeier": "tyler allgeier",
  "michael piuttman": "michael pittman"
};
export const norm = s => {
  const k = String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.'’\-]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
  return ALIASES[k] || k;
};

/* ---------------- rosters ---------------- */
// ROSTER_DATA rows: [first week it counts, team, dropped, slot, claimed, NFL team, via?]
export function rostersFor(RD, week) {
  const r = {};
  for (const code in RD.base)
    r[code] = RD.base[code].map(([pos, name, team]) => ({ pos, name, team }));
  for (const [eff, code, drop, pos, name, team] of RD.waivers) {
    if (eff > week) continue;
    applyMove(r, code, drop, name ? { pos, name, team } : null);
  }
  return r;
}
function applyMove(r, code, drop, p) {
  if (!drop) { if (p) r[code].push(p); return; }
  const i = r[code].findIndex(x => norm(x.name) === norm(drop));
  if (i < 0) return;
  if (p) r[code][i] = p; else r[code].splice(i, 1);
}
export function cloneRosters(r) {
  const out = {};
  for (const c in r) out[c] = r[c].map(p => Object.assign({}, p));
  return out;
}
// Apply a resolved run's awards to a copy of the rosters (for the following week).
export function applyResults(rosters, results) {
  const r = cloneRosters(rosters);
  for (const res of results) if (res.status === "claimed")
    applyMove(r, res.team, res.claim.drop_name || null,
      { pos: res.claim.claim_pos, name: res.claim.claim_name, team: res.claim.claim_nfl });
  return r;
}

/* ---------------- roster limits (Rule I-B-1) ---------------- */
// Post-draft counts: 2 K, 3 QB, 7 RB, 1 TE + 7 WR "or additional tight ends",
// 2 DL/LB, 2 DB; 24 total. Tight ends are listed as "TE/WR".
export const ROSTER_MAX = 24;
export const POS_MAX = { K: 2, QB: 3, RB: 7, WR: 7, "DL/LB": 2, DB: 2 };
export const REC_MAX = 8;      // WR + TE together
export const isTE = pos => pos === "TE/WR" || pos === "TE";
export const POSITIONS = ["K", "QB", "RB", "WR", "TE/WR", "DL/LB", "DB"];
export const posLabel = pos => isTE(pos) ? "TE" : pos;

function counts(list) {
  const c = { K: 0, QB: 0, RB: 0, WR: 0, TE: 0, "DL/LB": 0, DB: 0, total: list.length };
  for (const p of list) {
    if (isTE(p.pos)) c.TE++;
    else if (p.pos in c) c[p.pos]++;
  }
  return c;
}
// Why the roster would break a limit after the move, or "".
// Only the claimed player's position (and the roster size) is checked, so a
// roster already over somewhere else can still make a legal claim elsewhere.
export function limitReason(roster, claimPos, dropName) {
  const after = roster.filter(p => !(dropName && norm(p.name) === norm(dropName)));
  after.push({ pos: claimPos });
  const c = counts(after);
  if (c.total > ROSTER_MAX) return "roster would have " + c.total + " players (max " + ROSTER_MAX + ") — pick a player to drop";
  if (isTE(claimPos)) {
    if (c.WR + c.TE > REC_MAX) return "WR + TE would be " + (c.WR + c.TE) + " (max " + REC_MAX + ")";
    return "";
  }
  if (claimPos === "WR") {
    if (c.WR > POS_MAX.WR) return "WR would be " + c.WR + " (max " + POS_MAX.WR + ")";
    if (c.WR + c.TE > REC_MAX) return "WR + TE would be " + (c.WR + c.TE) + " (max " + REC_MAX + ")";
    return "";
  }
  if (!(claimPos in POS_MAX)) return "position " + claimPos + " has no roster spot";
  if (c[claimPos] > POS_MAX[claimPos]) return claimPos + " would be " + c[claimPos] + " (max " + POS_MAX[claimPos] + ")";
  return "";
}

/* ---------------- free agent pool (Rule III-D) ---------------- */
// Last week whose games come before the Trade Deadline (kickoff of the last game of Week 12).
export const TRADE_DEADLINE_WEEK = 12;
// Players released after the Trade Deadline: dropped in the post-week-12 run or later.
// Those runs' moves count from week 13 on. Trades/NFL-team rows are not releases.
export function releasedAfterDeadline(RD, extraResults) {
  const out = new Map();     // norm name -> {name, week}
  for (const [eff, code, drop, , , , via] of RD.waivers)
    if (drop && eff > TRADE_DEADLINE_WEEK && via !== "trade" && via !== "nfl")
      out.set(norm(drop), { name: drop, team: code, run: eff - 1 });
  for (const { week, results } of extraResults || [])
    if (week >= TRADE_DEADLINE_WEEK)
      for (const r of results) if (r.status === "claimed" && r.claim.drop_name)
        out.set(norm(r.claim.drop_name), { name: r.claim.drop_name, team: r.team, run: week });
  return out;
}
export function rosteredMap(rosters) {
  const m = new Map();       // norm name -> team code
  for (const code in rosters) for (const p of rosters[code]) m.set(norm(p.name), code);
  return m;
}

// Is this ranked-list entry legal for `team`? Returns "" or the reason.
// ctx: { rosters, rostered: rosteredMap(rosters), released: releasedAfterDeadline(...) }
export function claimReason(ctx, team, claim) {
  const roster = ctx.rosters[team] || [];
  if (!claim || !claim.claim_name) return "no player picked";
  if (!POSITIONS.includes(claim.claim_pos)) return "position " + claim.claim_pos + " has no roster spot";
  const key = norm(claim.claim_name);
  const on = ctx.rostered.get(key);
  if (on) return claim.claim_name + " is on " + (on === team ? "your" : on + "'s") + " roster";
  const rel = ctx.released.get(key);
  if (rel) return claim.claim_name + " was released after the trade deadline (" + rel.team + ", post-week-" + rel.run + ") and can't be claimed this season";
  if (claim.drop_name) {
    if (!roster.some(p => norm(p.name) === norm(claim.drop_name))) return claim.drop_name + " is not on your roster";
  } else if (roster.length >= ROSTER_MAX) {
    return "your roster is full (" + roster.length + ") — pick a player to drop";
  }
  return limitReason(roster, claim.claim_pos, claim.drop_name);
}

/* ---------------- selection order (Rule III-B, III-C) ---------------- */
// games: [{week, a, b, ap, bp}] — the counted results through the week just played.
// Returns { order: [code...] (first pick first), info: {code: {pf, pa, note}}, coinNeeded: [[codes]] }.
//
// Inverted overall points: fewest points picks first. In a tie, the team that
// wins a tiebreaker is treated as the stronger team and picks LATER (the same way
// it would rank higher in the standings). Flip WINNER_PICKS_LATER if the league
// reads Rule III-C the other way. Coin tosses are entered as a pick order
// directly (rank 1 picks first), so that step doesn't depend on this setting.
export const WINNER_PICKS_LATER = true;
const EPS = 1e-9;

export function waiverOrder(codes, games, coin) {
  const T = {};
  for (const c of codes) T[c] = { pf: 0, pa: 0 };
  for (const g of games) {
    if (g.a in T) { T[g.a].pf += g.ap; T[g.a].pa += g.bp; }
    if (g.b in T) { T[g.b].pf += g.bp; T[g.b].pa += g.ap; }
  }
  const info = {}, coinNeeded = [];
  for (const c of codes) info[c] = { pf: T[c].pf, pa: T[c].pa, note: "" };

  const h2h = (G, c) => {
    let w = 0, t = 0, n = 0, diff = 0;
    for (const g of games) {
      if (!G.includes(g.a) || !G.includes(g.b)) continue;
      if (g.a !== c && g.b !== c) continue;
      const mine = g.a === c ? g.ap : g.bp, theirs = g.a === c ? g.bp : g.ap;
      n++; diff += mine - theirs;
      if (Math.abs(mine - theirs) < EPS) t++; else if (mine > theirs) w++;
    }
    return { n, pct: n ? (w + t / 2) / n : null, diff };
  };
  // Tiebreakers, in order. Each returns a "strength" per team (higher = stronger),
  // or null when it can't be applied (some tied team has no games against the others).
  const BREAKERS = [
    { name: "head-to-head record", f: G => { const v = G.map(c => h2h(G, c)); return v.some(x => !x.n) ? null : v.map(x => x.pct); } },
    { name: "head-to-head point differential", f: G => { const v = G.map(c => h2h(G, c)); return v.some(x => !x.n) ? null : v.map(x => x.diff); } },
    { name: "overall point differential", f: G => G.map(c => T[c].pf - T[c].pa) }
  ];

  function breakTie(G, k) {
    if (G.length === 1) return G;
    if (k >= BREAKERS.length) {
      const ranks = coin || {};
      const tied = G.slice().sort();
      if (tied.every(c => Number.isFinite(ranks[c]))) {
        tied.sort((x, y) => ranks[x] - ranks[y]);
        for (const c of tied) info[c].note = "tie with " + others(tied, c) + " broken by coin toss";
        return tied;
      }
      coinNeeded.push(tied);
      for (const c of tied) info[c].note = "still tied with " + others(tied, c) + " — coin toss needed";
      return tied;
    }
    const vals = BREAKERS[k].f(G);
    if (!vals) return breakTie(G, k + 1);
    const groups = [];
    G.forEach((c, i) => {
      const grp = groups.find(x => Math.abs(x.v - vals[i]) < EPS);
      if (grp) grp.c.push(c); else groups.push({ v: vals[i], c: [c] });
    });
    if (groups.length === 1) return breakTie(G, k + 1);
    groups.sort((x, y) => WINNER_PICKS_LATER ? x.v - y.v : y.v - x.v);
    const out = [];
    for (const grp of groups) {
      if (grp.c.length === 1) info[grp.c[0]].note = "tie with " + others(G, grp.c[0]) + " broken by " + BREAKERS[k].name;
      // a smaller group still tied starts over at the first tiebreaker (Rule III-C)
      out.push(...breakTie(grp.c, 0));
    }
    return out;
  }
  const others = (G, c) => G.filter(x => x !== c).join(", ");

  const sorted = codes.slice().sort((x, y) => T[x].pf - T[y].pf);
  const order = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && Math.abs(T[sorted[j]].pf - T[sorted[i]].pf) < EPS) j++;
    order.push(...breakTie(sorted.slice(i, j), 0));
    i = j;
  }
  return { order, info, coinNeeded };
}

/* ---------------- resolving a run (Rule III-F) ---------------- */
// claimsByTeam: {code: [claim rows sorted by rank]}. Each team, in selection order,
// gets the highest-ranked player on its list that an earlier team hasn't just taken.
// An entry that breaks the Rule Book voids the team's claim, with no advancing.
// Returns [{team, pick, status: "claimed"|"void"|"none"|"no list", claim, entries:[{claim, outcome, note}]}].
export function resolveRun(order, claimsByTeam, ctx) {
  const taken = new Map();     // norm name -> team that got him this run
  const out = [];
  order.forEach((team, idx) => {
    const list = (claimsByTeam[team] || []).slice().sort((a, b) => a.rank - b.rank);
    const res = { team, pick: idx + 1, status: list.length ? "none" : "no list", claim: null, entries: [] };
    let done = false;
    for (const claim of list) {
      const e = { claim, outcome: "not reached", note: "" };
      res.entries.push(e);
      if (done) continue;
      const by = taken.get(norm(claim.claim_name));
      if (by) { e.outcome = "taken"; e.note = "claimed by " + by + " (pick " + (order.indexOf(by) + 1) + ")"; continue; }
      const why = claimReason(ctx, team, claim);
      if (why) {
        e.outcome = "void"; e.note = why;
        res.status = "void"; done = true; continue;
      }
      e.outcome = "awarded";
      res.status = "claimed"; res.claim = claim; done = true;
      taken.set(norm(claim.claim_name), team);
    }
    out.push(res);
  });
  return out;
}

/* ---------------- announcement text (same shape as the old results email) ---------------- */
// The scheduled roster task reads lines like "PD drops RB Ray Davis, claims RB Emanuel Wilson SEA".
export const EMAIL_CODE = { PD: "PD", OS: "O&S", FAB: "FAB", WILD: "WG", SV: "SV", RHR: "RHR", COM: "COM", NUTS: "NUTS" };
export function resultLines(results, rosters) {
  return results.map(r => {
    const code = EMAIL_CODE[r.team] || r.team;
    if (r.status !== "claimed") return code + " no claim";
    const c = r.claim;
    const dropped = c.drop_name ? (rosters[r.team] || []).find(p => norm(p.name) === norm(c.drop_name)) : null;
    const drop = c.drop_name ? "drops " + (dropped ? posLabel(dropped.pos) + " " : "") + c.drop_name : "drops none";
    return code + " " + drop + ", claims " + posLabel(c.claim_pos) + " " + c.claim_name + " " + c.claim_nfl;
  });
}
