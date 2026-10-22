// Decision-table tests for site/shiporkill.js:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readout, naive, naiveGuard, plan, perArm } from "../site/shiporkill.js";

// A clean final readout: 10,000 per arm, primary D1 at 30% in control
function req({ d1Test = 3000, act = [2500, 2500], un = [850, 850], crash = [200, 200], assigned = [10000, 10000],
  day = 16, enrolDays = 14, segments, audits, primary } = {}) {
  const m = (id, label, role, better, c, t, extra = {}) => ({ id, label, role, better, den_kind: "assigned",
    control: { num: c, den: assigned[0] }, test: { num: t, den: assigned[1] }, ...extra });
  return {
    plan: { per_arm: 10000, days: 14, split: 0.5, alpha: 0.05 },
    readout: { day, enrolment_days: enrolDays },
    assigned: { control: assigned[0], test: assigned[1] },
    segments: segments || [{ name: "all", control: assigned[0], test: assigned[1] }],
    metrics: [
      primary || m("d1", "D1 retention", "primary", "up", 3000, d1Test, { mwe_rel: 0.05 }),
      m("act", "D0 couple activation", "guardrail", "up", act[0], act[1], { margin_rel: 0.08 }),
      m("un", "Uninstalls within 48 h", "guardrail", "down", un[0], un[1], { margin_rel: 0.12 }),
      m("crash", "Users with a crash within 48 h", "guardrail", "down", crash[0], crash[1], { margin_rel: 0.5 }),
    ],
    audits: audits || [{ id: "shared_without_partner", label: "Shared game with no partner joined", threshold: 0.005,
      control: { num: 5, den: assigned[0] }, test: { num: 6, den: assigned[1] } }],
  };
}

test("a clear win with safe guardrails rolls out", () => {
  assert.equal(readout(req({ d1Test: 3300 })).verdict, "roll_out");
});

test("a clear loss is killed", () => {
  assert.equal(readout(req({ d1Test: 2750 })).verdict, "kill");
});

test("a result that rules out the minimum worthwhile effect is killed (FLAT)", () => {
  const primary = { id: "d1", label: "D1 retention", role: "primary", better: "up", den_kind: "assigned", mwe_rel: 0.05,
    control: { num: 12000, den: 40000 }, test: { num: 12040, den: 40000 } };
  const r = readout(req({ assigned: [40000, 40000], act: [10000, 10000], un: [3400, 3400], crash: [800, 800], primary }));
  assert.equal(r.primary.cls, "FLAT");
  assert.equal(r.verdict, "kill");
});

test("an underpowered result iterates", () => {
  const r = readout(req({ d1Test: 3060 }));
  assert.equal(r.primary.cls, "INCONCLUSIVE");
  assert.equal(r.verdict, "iterate");
});

test("a win that breaches a guardrail iterates", () => {
  const r = readout(req({ d1Test: 3300, un: [850, 1150] }));
  assert.equal(r.guardrails.find((g) => g.id === "un").status, "BREACH");
  assert.equal(r.verdict, "iterate");
});

test("a win with a guardrail that can't be ruled out iterates; naive with a significance veto ships it", () => {
  const r = readout(req({ d1Test: 3300, un: [850, 910] }));
  assert.equal(r.guardrails.find((g) => g.id === "un").status, "UNCLEAR");
  assert.equal(r.verdict, "iterate");
  assert.equal(naiveGuard(req({ d1Test: 3300, un: [850, 910] })), "roll_out");
});

test("sample ratio mismatch blocks the call", () => {
  const r = readout(req({ d1Test: 3300, assigned: [10000, 9400] }));
  assert.equal(r.verdict, "fix_data");
});

test("a mismatch hidden in one segment blocks the call", () => {
  const r = readout(req({ d1Test: 3300, segments: [{ name: "android_old", control: 1200, test: 900 },
    { name: "rest", control: 8800, test: 9100 }] }));
  assert.equal(r.verdict, "fix_data");
});

test("a failed tracking audit blocks the call", () => {
  const audits = [{ id: "shared_without_partner", label: "Shared game with no partner joined", threshold: 0.005,
    control: { num: 5, den: 10000 }, test: { num: 40, den: 10000 } }];
  assert.equal(readout(req({ d1Test: 3300, audits })).verdict, "fix_data");
});

test("an interim look keeps running, even at p < 0.05", () => {
  const r = readout(req({ d1Test: 3200, day: 6, enrolDays: 6 }));
  assert.equal(naive(req({ d1Test: 3200, day: 6, enrolDays: 6 })), "roll_out");
  assert.equal(r.verdict, "keep_running");
});

test("an interim look stops for clear harm", () => {
  assert.equal(readout(req({ d1Test: 2600, day: 6, enrolDays: 6 })).verdict, "kill");
});

test("a subset primary is read per assigned user through its twin", () => {
  const r0 = req({ d1Test: 2950 });
  r0.metrics[0] = { ...r0.metrics[0], role: "secondary", mwe_rel: undefined };
  r0.metrics.unshift({ id: "d1_act", label: "D1 retention of activated couples", role: "primary", better: "up",
    den_kind: "subset", itt_twin: "d1", mwe_rel: 0.05, control: { num: 1500, den: 2500 }, test: { num: 1600, den: 2400 } });
  assert.equal(naive(r0), "roll_out");
  const r = readout(r0);
  assert.equal(r.primary.id, "d1");
  assert.notEqual(r.verdict, "roll_out");
});

test("a subset primary with no per-assigned twin can't roll out", () => {
  const r0 = req();
  r0.metrics[0] = { id: "d1_act", label: "D1 retention of activated couples", role: "primary", better: "up",
    den_kind: "subset", mwe_rel: 0.05, control: { num: 1500, den: 2500 }, test: { num: 1700, den: 2400 } };
  assert.equal(readout(r0).verdict, "iterate");
});

test("planner: textbook sample size, and guardrails raise it", () => {
  assert.equal(perArm(0.3, 0.05), 14856);
  const p = plan({ baseline: 0.25, mweRel: 0.08, dailyUsers: 1500,
    guardrails: [{ label: "Users with a crash within 48 h", baseline: 0.02, marginRel: 0.25 }] });
  assert.ok(p.recommendedN > p.primaryOnlyN);
  assert.equal(p.days % 7, 0);
});
