// node --test test/waiver-engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../web/waiver-engine.js";

const html = readFileSync(new URL("../web/weekly.html", import.meta.url), "utf8");
const RD = JSON.parse(html.match(/const ROSTER_DATA = (\{[\s\S]*?\});\n/)[1]);
const CODES = ["PD", "OS", "FAB", "WILD", "SV", "RHR", "COM", "NUTS"];

function ctxFor(rosters, released) {
  return { rosters, rostered: E.rosteredMap(rosters), released: released || new Map() };
}

test("real rosters: 24 per team except SV (trade) and limits hold", () => {
  const r = E.rostersFor(RD, 11);
  for (const c of CODES) assert.ok(r[c].length <= 24, c + " " + r[c].length);
});

test("roster limits", () => {
  const roster = [
    ...Array(2).fill(0).map((_, i) => ({ pos: "K", name: "K" + i })),
    ...Array(3).fill(0).map((_, i) => ({ pos: "QB", name: "QB" + i })),
    ...Array(7).fill(0).map((_, i) => ({ pos: "RB", name: "RB" + i })),
    ...Array(2).fill(0).map((_, i) => ({ pos: "TE/WR", name: "TE" + i })),
    ...Array(6).fill(0).map((_, i) => ({ pos: "WR", name: "WR" + i })),
    ...Array(2).fill(0).map((_, i) => ({ pos: "DL/LB", name: "DL" + i })),
    ...Array(2).fill(0).map((_, i) => ({ pos: "DB", name: "DB" + i }))
  ];
  assert.equal(roster.length, 24);
  assert.equal(E.limitReason(roster, "RB", "RB0"), "");
  assert.match(E.limitReason(roster, "RB", "QB0"), /RB would be 8/);
  assert.equal(E.limitReason(roster, "WR", "TE0"), "");           // 7 WR + 1 TE
  assert.match(E.limitReason(roster, "WR", "QB0"), /WR \+ TE would be 9/);
  assert.match(E.limitReason(roster, "QB", null), /no open QB spot \(3 of 3\)/);
  assert.equal(E.limitReason(roster.slice(1), "K", null), "");   // K spot open after trading a K away
  assert.equal(E.limitReason(roster.slice(1), "K", null), "");    // 23 players, 1 K -> add K
  assert.match(E.limitReason(roster, "DB", "K0"), /DB would be 3/);
  assert.equal(E.limitReason(roster, "TE/WR", "WR0"), "");
});

test("claim validity: rostered, released after deadline, missing drop, full roster", () => {
  const r = E.rostersFor(RD, 11);
  const released = new Map([[E.norm("Joe Example"), { name: "Joe Example", team: "PD", run: 12 }]]);
  const ctx = ctxFor(r, released);
  const rhrDrop = r.RHR.find(p => p.pos === "RB").name;
  assert.match(E.claimReason(ctx, "RHR", { claim_name: "Puka Nacua", claim_pos: "WR", claim_nfl: "LAR", drop_name: rhrDrop }), /your roster/);
  assert.match(E.claimReason(ctx, "RHR", { claim_name: "Josh Allen", claim_pos: "QB", claim_nfl: "BUF", drop_name: rhrDrop }), /NUTS's roster/);
  assert.match(E.claimReason(ctx, "RHR", { claim_name: "Joe Example", claim_pos: "RB", claim_nfl: "NE", drop_name: rhrDrop }), /released after the trade deadline/);
  assert.match(E.claimReason(ctx, "RHR", { claim_name: "Free Guy", claim_pos: "RB", claim_nfl: "NE", drop_name: "Nobody Here" }), /not on your roster/);
  assert.match(E.claimReason(ctx, "RHR", { claim_name: "Free Guy", claim_pos: "RB", claim_nfl: "NE", drop_name: null }), /roster is full/);
  assert.equal(E.claimReason(ctx, "RHR", { claim_name: "Free Guy", claim_pos: "RB", claim_nfl: "NE", drop_name: rhrDrop }), "");
});

test("2026 rule: drop must be the same position; no drop only into an open spot", () => {
  const r = E.rostersFor(RD, 11);
  const ctx = ctxFor(r);
  const k = r.RHR.find(p => p.pos === "K").name, wr = r.RHR.find(p => p.pos === "WR").name, rbs = r.RHR.filter(p => p.pos === "RB");
  assert.match(E.claimReason(ctx, "RHR", { claim_name: "Free Guy", claim_pos: "RB", claim_nfl: "NE", drop_name: k }), /to claim a RB you must drop a RB .* is a K/);
  assert.equal(E.claimReason(ctx, "RHR", { claim_name: "Free TE", claim_pos: "TE/WR", claim_nfl: "NE", drop_name: wr }), "");   // WR/TE one group
  // trade an RB away: can claim an RB with no drop, but a WR still needs a WR dropped
  const short = { ...r, RHR: r.RHR.filter(p => p.name !== rbs[0].name) };
  const c2 = ctxFor(short);
  assert.equal(E.claimReason(c2, "RHR", { claim_name: "Free Guy", claim_pos: "RB", claim_nfl: "NE", drop_name: null }), "");
  assert.match(E.claimReason(c2, "RHR", { claim_name: "Free WR", claim_pos: "WR", claim_nfl: "NE", drop_name: null }), /no open WR\/TE spot/);
  assert.match(E.claimReason(c2, "RHR", { claim_name: "Free WR", claim_pos: "WR", claim_nfl: "NE", drop_name: rbs[1].name }), /must drop a WR\/TE/);
});

test("released after deadline comes from post-week-12+ runs only", () => {
  const RD2 = { base: RD.base, waivers: RD.waivers.concat([[12, "PD", "Early Drop", "RB", "X1", "NE"], [13, "PD", "Late Drop", "RB", "X2", "NE"], [13, "SV", "Traded Guy", "RB", "X3", "NE", "trade"]]) };
  const m = E.releasedAfterDeadline(RD2, [{ week: 13, results: [{ team: "OS", status: "claimed", claim: { drop_name: "Page Drop" } }] }]);
  assert.ok(m.has(E.norm("Late Drop")));
  assert.ok(m.has(E.norm("Page Drop")));
  assert.ok(!m.has(E.norm("Early Drop")));
  assert.ok(!m.has(E.norm("Traded Guy")));
});

const g = (week, a, b, ap, bp) => ({ week, a, b, ap, bp });

test("order: fewest points first", () => {
  const games = [g(1, "PD", "WILD", 100, 90), g(1, "OS", "FAB", 80, 70), g(1, "SV", "NUTS", 60, 50), g(1, "RHR", "COM", 40, 30)];
  const o = E.waiverOrder(CODES, games, {});
  assert.deepEqual(o.order, ["COM", "RHR", "NUTS", "SV", "FAB", "OS", "WILD", "PD"]);
  assert.deepEqual(o.coinNeeded, []);
});

test("order: two-way tie broken by head-to-head (winner picks later)", () => {
  const games = [g(1, "PD", "OS", 100, 90), g(2, "PD", "FAB", 50, 60), g(2, "OS", "WILD", 60, 50)];
  // PD 150, OS 150 -> PD beat OS head-to-head, so PD is the stronger team and picks after OS.
  const o = E.waiverOrder(["PD", "OS"], games, {});
  assert.deepEqual(o.order, ["OS", "PD"]);
  assert.match(o.info.PD.note, /head-to-head record/);
});

test("order: falls through to overall point differential, then coin toss", () => {
  // A and B never played each other: h2h can't apply -> overall differential.
  const games = [g(1, "PD", "FAB", 100, 50), g(1, "OS", "WILD", 100, 80)];
  let o = E.waiverOrder(["PD", "OS"], games, {});
  assert.deepEqual(o.order, ["OS", "PD"]);            // OS +20, PD +50 -> PD stronger, picks later
  assert.match(o.info.OS.note, /overall point differential/);

  const same = [g(1, "PD", "FAB", 100, 50), g(1, "OS", "WILD", 100, 50)];
  o = E.waiverOrder(["PD", "OS"], same, {});
  assert.equal(o.coinNeeded.length, 1);
  assert.deepEqual(o.coinNeeded[0].sort(), ["OS", "PD"]);
  o = E.waiverOrder(["PD", "OS"], same, { PD: 1, OS: 2 });
  assert.deepEqual(o.order, ["PD", "OS"]);
  assert.match(o.info.PD.note, /coin toss/);
});

test("order: three-way tie, then the remaining two restart at head-to-head", () => {
  // PD, OS, FAB all 200 total. Among the three: PD 2-0, OS 0-1 + beat? Build:
  // PD beat OS 110-90, PD beat FAB 105-95, FAB beat OS ... wait want OS/FAB tied on 3-way pct.
  const games = [
    g(1, "PD", "OS", 110, 90), g(2, "PD", "FAB", 90, 100),   // PD 1-1
    g(3, "OS", "FAB", 110, 100),                              // OS 1-1, FAB 1-1
    // padding games vs others to equalize totals at 300
    g(4, "PD", "WILD", 100, 0), g(4, "OS", "SV", 100, 0), g(4, "FAB", "NUTS", 100, 0)
  ];
  // totals: PD 110+90+100=300, OS 90+110+100=300, FAB 100+100+100=300. All 1-1 -> h2h pct tied.
  // h2h diff among 3: PD +20-10=+10, OS -20+10=-10, FAB +10-10=0 -> OS weakest, FAB, PD strongest.
  const o = E.waiverOrder(["PD", "OS", "FAB", "WILD", "SV", "NUTS"], games, {});
  assert.deepEqual(o.order.slice(3), ["OS", "FAB", "PD"]);
});

test("resolve: earlier pick wins a player, next team advances; void stops", () => {
  const r = E.rostersFor(RD, 11);
  const ctx = ctxFor(r);
  const drop = c => r[c].find(p => p.pos === "RB").name;
  const claims = {
    COM: [{ rank: 1, claim_name: "Free A", claim_pos: "RB", claim_nfl: "NE", drop_name: drop("COM") }],
    RHR: [{ rank: 1, claim_name: "Free A", claim_pos: "RB", claim_nfl: "NE", drop_name: drop("RHR") },
          { rank: 2, claim_name: "Free B", claim_pos: "RB", claim_nfl: "NE", drop_name: drop("RHR") }],
    NUTS: [{ rank: 1, claim_name: "Josh Allen", claim_pos: "QB", claim_nfl: "BUF", drop_name: drop("NUTS") },
           { rank: 2, claim_name: "Free C", claim_pos: "RB", claim_nfl: "NE", drop_name: drop("NUTS") }]
  };
  const res = E.resolveRun(["COM", "RHR", "NUTS", "SV"], claims, ctx);
  assert.equal(res[0].status, "claimed"); assert.equal(res[0].claim.claim_name, "Free A");
  assert.equal(res[1].status, "claimed"); assert.equal(res[1].claim.claim_name, "Free B");
  assert.equal(res[1].entries[0].outcome, "taken");
  assert.equal(res[2].status, "void");    // claimed a rostered player: no advancing to Free C
  assert.equal(res[2].entries[1].outcome, "not reached");
  assert.equal(res[3].status, "no list");

  const lines = E.resultLines(res, r);
  assert.equal(lines[0], "COM drops RB " + drop("COM") + ", claims RB Free A NE");
  assert.equal(lines[2], "NUTS no claim");
  const after = E.applyResults(r, res);
  assert.ok(after.COM.some(p => p.name === "Free A"));
  assert.ok(!after.COM.some(p => p.name === drop("COM")));
  assert.equal(after.COM.length, r.COM.length);
});

test("resolve: claim without a drop when under 24", () => {
  const r = E.rostersFor(RD, 11);
  r.SV = r.SV.slice(0, 23);
  const res = E.resolveRun(["SV"], { SV: [{ rank: 1, claim_name: "Free K", claim_pos: "K", claim_nfl: "NE", drop_name: null }] }, ctxFor(r));
  // SV still has its 2 kickers? if so the K limit applies
  const ks = r.SV.filter(p => p.pos === "K").length;
  assert.equal(res[0].status, ks >= 2 ? "void" : "claimed");
  assert.match(E.resultLines(res, r)[0], ks >= 2 ? /no claim/ : /SV drops none, claims K Free K NE/);
});
