// Ship or Kill: reads an A/B test the way docs/PRD.md says, in a fixed order, and makes the call.
// One module for the web page and the benchmark runner. No dependencies.
//
//   readout(request)  -> { verdict, headline, next, steps, metrics, ... }
//   plan(params)      -> sample size, days and guardrail checks for a planned test
//   naive(request), naiveGuard(request) -> the two baseline rules the benchmark compares against

export const VERSION = "1.0";

export const RULES = {
  srmFail: 0.001,          // sample ratio mismatch: fail below this p-value (overall or any segment)
  srmWarn: 0.01,
  auditDiffP: 0.001,       // an audit also fails when arms differ at this p and one rate is > 2x the other
  auditRatio: 2,
  doneShare: 0.9,          // final once planned days have passed and each arm has 90% of the planned sample
  interimHarmP: 0.001,     // interim looks may only kill, for harm at this p
  primaryZ: 1.959963984540054,   // 95% two-sided interval for the primary
  guardZ: 1.6448536269514722,    // 90% two-sided interval = one-sided 5% non-inferiority for guardrails
  power: 0.8,
};

// ---------------------------------------------------------------------------------------------------------
// Statistics

// Complementary error function, Numerical Recipes erfcc (fractional error < 1.2e-7 everywhere)
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

export const normSf = (z) => 0.5 * erfc(z / Math.SQRT2);   // P(Z > z)
export const normCdf = (z) => 1 - normSf(z);
export const twoSidedP = (z) => Math.min(1, 2 * normSf(Math.abs(z)));

// Inverse normal CDF (Acklam), with one Halley refinement step
export function normInv(p) {
  if (p <= 0 || p >= 1) throw new Error("normInv needs 0 < p < 1");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

// Difference of two proportions, test minus control. Interval and p-value from the Agresti-Caffo adjusted
// Wald (add one success and one failure to each arm), so they always agree with each other.
export function propDiff(c, t, z = RULES.primaryZ) {
  const pc = c.den ? c.num / c.den : NaN, pt = t.den ? t.num / t.den : NaN;
  const ac = (c.num + 1) / (c.den + 2), at = (t.num + 1) / (t.den + 2);
  const se = Math.sqrt(ac * (1 - ac) / (c.den + 2) + at * (1 - at) / (t.den + 2));
  const d = at - ac;
  return { pc, pt, diff: pt - pc, rel: pc > 0 ? (pt - pc) / pc : NaN, adj: d, se, lo: d - z * se, hi: d + z * se,
    p: twoSidedP(d / se) };
}

// Pooled two-proportion z-test: what most dashboards and calculators show (used by the naive baselines)
export function pooledP(c, t) {
  if (!c.den || !t.den) return { p: 1, z: 0 };
  const p = (c.num + t.num) / (c.den + t.den);
  const se = Math.sqrt(p * (1 - p) * (1 / c.den + 1 / t.den));
  if (!(se > 0)) return { p: 1, z: 0 };
  const z = (t.num / t.den - c.num / c.den) / se;
  return { p: twoSidedP(z), z };
}

// Sample ratio mismatch: chi-square goodness of fit (1 df) of two arm counts against the planned test share
export function srm(control, test, testShare = 0.5) {
  const n = control + test;
  if (!n) return { p: 1, chi2: 0, share: NaN };
  const et = n * testShare, ec = n - et;
  const chi2 = (test - et) ** 2 / et + (control - ec) ** 2 / ec;
  return { p: erfc(Math.sqrt(chi2 / 2)), chi2, share: test / n };
}

// Users per arm for a two-sided test of two proportions (normal approximation, no continuity correction)
export function perArm(p1, relMwe, alpha = 0.05, power = RULES.power) {
  const p2 = p1 * (1 + relMwe), pbar = (p1 + p2) / 2;
  const za = normInv(1 - alpha / 2), zb = normInv(power);
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2;
  return Math.ceil(n);
}

// ---------------------------------------------------------------------------------------------------------
// Formatting

const pts = (x, signed = true) => {
  const v = x * 100;
  const s = Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1);
  return (signed && v > 0 ? "+" : "") + s;
};
const pct = (x, digits = 1) => (x * 100).toFixed(digits) + "%";
const relTxt = (x) => (x > 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
export const fmtP = (p) => (p < 0.0001 ? "< 0.0001" : p < 0.001 ? p.toExponential(1) : p.toFixed(p < 0.01 ? 4 : 3));
const int = (n) => Math.round(n).toLocaleString("en-US");
// Lower-case a label's first letter for use mid-sentence, but leave acronyms and codes (D1, SRM) alone
const lower = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------------------------------------
// The readout

export function readout(req) {
  const split = req.plan?.split ?? 0.5;
  const metricsById = Object.fromEntries((req.metrics || []).map((m) => [m.id, m]));
  const notes = [];
  const steps = [];

  // 1. Trust ------------------------------------------------------------------------------------------
  const trust = { key: "trust", title: "Can the data be trusted?", items: [] };
  const overall = srm(req.assigned.control, req.assigned.test, split);
  const srmStatus = overall.p < RULES.srmFail ? "fail" : overall.p < RULES.srmWarn ? "warn" : "pass";
  trust.items.push({
    label: "Sample ratio, all users",
    status: srmStatus,
    detail: `Test arm has ${pct(overall.share, 2)} of users (planned ${pct(split, 0)}): ${int(req.assigned.control)} control, ` +
      `${int(req.assigned.test)} test. Chi-square p = ${fmtP(overall.p)}.`,
  });
  const segResults = (req.segments || []).map((s) => ({ ...s, ...srm(s.control, s.test, split) }));
  const worstSeg = segResults.reduce((w, s) => (!w || s.p < w.p ? s : w), null);
  if (worstSeg) {
    const segStatus = worstSeg.p < RULES.srmFail ? "fail" : worstSeg.p < RULES.srmWarn ? "warn" : "pass";
    const missing = (seg) => {
      const n = seg.control + seg.test;
      const short = seg.share < split ? "test" : "control";
      const expected = short === "test" ? n * split : n * (1 - split);
      const have = short === "test" ? seg.test : seg.control;
      return `${short} arm ${relTxt(have / expected - 1)} vs expected`;
    };
    trust.items.push({
      label: "Sample ratio, by segment",
      status: segStatus,
      detail: segStatus === "pass"
        ? `All ${segResults.length} segments match the planned split (lowest p = ${fmtP(worstSeg.p)}, ${worstSeg.name}).`
        : `${worstSeg.name}: ${int(worstSeg.control)} control, ${int(worstSeg.test)} test (${missing(worstSeg)}), p = ${fmtP(worstSeg.p)}.`,
    });
  }
  const audits = (req.audits || []).map((a) => {
    const rc = a.control.den ? a.control.num / a.control.den : 0;
    const rt = a.test.den ? a.test.num / a.test.den : 0;
    const dp = pooledP(a.control, a.test).p;
    const hi = Math.max(rc, rt), lo = Math.min(rc, rt);
    const overThreshold = hi > a.threshold;
    const lopsided = dp < RULES.auditDiffP && (lo === 0 ? hi > 0 : hi / lo > RULES.auditRatio);
    const status = overThreshold || lopsided ? "fail" : "pass";
    return { ...a, rc, rt, p: dp, status,
      detail: `${pct(rc, 2)} of control, ${pct(rt, 2)} of test (${a.control.num} vs ${a.test.num}); limit ${pct(a.threshold, 1)}` +
        (lopsided && !overThreshold ? `; the arms differ (p = ${fmtP(dp)})` : "") + "." };
  });
  for (const a of audits) trust.items.push({ label: a.label, status: a.status, detail: a.detail });
  const trustFail = trust.items.some((i) => i.status === "fail");
  trust.status = trustFail ? "fail" : trust.items.some((i) => i.status === "warn") ? "warn" : "pass";
  steps.push(trust);

  // 2. Done? ------------------------------------------------------------------------------------------
  const plan = req.plan || {};
  const planned = plan.per_arm || 0;
  const enrolled = req.readout?.enrolment_days ?? plan.days;
  const minArm = Math.min(req.assigned.control, req.assigned.test);
  const sampleShare = planned ? minArm / planned : 1;
  const final = enrolled >= (plan.days || 0) && sampleShare >= RULES.doneShare;
  const done = { key: "done", title: "Is the test done?", status: final ? "pass" : "warn", items: [{
    label: "Planned sample and duration",
    status: final ? "pass" : "warn",
    detail: `${enrolled} of ${plan.days} planned days enrolled; smaller arm at ${pct(sampleShare, 0)} of the planned ` +
      `${int(planned)} per arm.` + (final ? "" : " This is an interim look: the only call allowed is kill, for clear harm."),
  }] };
  steps.push(done);

  // 3. Primary ----------------------------------------------------------------------------------------
  const registered = (req.metrics || []).find((m) => m.role === "primary");
  if (!registered) throw new Error("request has no primary metric");
  let primary = registered;
  const prim = { key: "primary", title: "Did the primary metric move, per assigned user?", items: [] };
  let conditionalBlocked = false;
  if (registered.den_kind === "subset") {
    const twin = registered.itt_twin && metricsById[registered.itt_twin];
    if (twin) {
      primary = { ...twin, mwe_rel: registered.mwe_rel, role: "primary" };
      prim.items.push({ label: "Primary measured on a subset", status: "warn",
        detail: `The registered primary, ${lower(registered.label)}, counts only users who got through a step after ` +
          `assignment. A variant that filters out weaker users raises it on its own. The call uses ${lower(twin.label)} ` +
          `per assigned user instead, with the same ${relTxt(registered.mwe_rel)} minimum worthwhile effect.` });
    } else {
      conditionalBlocked = true;
      prim.items.push({ label: "Primary measured on a subset", status: "fail",
        detail: `The registered primary, ${lower(registered.label)}, counts only users who got through a step after ` +
          `assignment, and no per-assigned version was supplied. It can't support a roll-out.` });
    }
  }
  const pr = propDiff(primary.control, primary.test, RULES.primaryZ);
  const sign = primary.better === "down" ? -1 : 1;
  const gain = { est: sign * pr.diff, lo: sign > 0 ? pr.lo : -pr.hi, hi: sign > 0 ? pr.hi : -pr.lo };
  const mweAbs = (primary.mwe_rel || 0) * pr.pc;
  let primaryClass;
  if (gain.lo > 0) primaryClass = "WIN";
  else if (gain.hi < 0) primaryClass = "LOSS";
  else if (gain.hi < mweAbs) primaryClass = "FLAT";
  else primaryClass = "INCONCLUSIVE";
  const mdeNow = (RULES.primaryZ + normInv(RULES.power)) * pr.se;
  const neededN = primary.mwe_rel ? perArm(pr.pc, primary.mwe_rel, plan.alpha ?? 0.05, RULES.power) : NaN;
  prim.items.push({
    label: primary.label,
    status: primaryClass === "WIN" ? "pass" : primaryClass === "INCONCLUSIVE" ? "warn" : "fail",
    detail: `${pct(pr.pc, 2)} control, ${pct(pr.pt, 2)} test: ${pts(pr.diff)} points (${relTxt(pr.rel)}), 95% CI ` +
      `${pts(pr.lo)} to ${pts(pr.hi)}, p = ${fmtP(pr.p)}. Minimum worthwhile effect: ${primary.better === "down" ? "a fall" : "a rise"} ` +
      `of ${pts(mweAbs, false)} points (${pct(primary.mwe_rel || 0, 1)}). ` + {
        WIN: "The whole interval is on the good side of zero.",
        LOSS: "The whole interval is on the bad side of zero.",
        FLAT: "The interval rules out a worthwhile effect.",
        INCONCLUSIVE: `The test can't tell: the interval reaches both zero and the minimum worthwhile effect. ` +
          `It could detect about ${pts(mdeNow, false)} points; the minimum needs about ${int(neededN)} per arm.`,
      }[primaryClass],
  });
  prim.status = primaryClass === "WIN" ? "pass" : primaryClass === "INCONCLUSIVE" ? "warn" : "fail";
  prim.result = primaryClass;
  steps.push(prim);

  // 4. Guardrails -------------------------------------------------------------------------------------
  const guard = { key: "guardrails", title: "Can we rule out harm?", items: [] };
  const guardResults = (req.metrics || []).filter((m) => m.role === "guardrail").map((g) => {
    const r = propDiff(g.control, g.test, RULES.guardZ);
    const s = g.better === "down" ? 1 : -1;            // harm = change in the bad direction
    const harm = s * r.adj, harmLo = s > 0 ? r.lo : -r.hi, harmHi = s > 0 ? r.hi : -r.lo;
    const margin = (g.margin_rel || 0) * r.pc;
    let status;
    if (harmHi <= margin) status = "PASS";
    else if (harmLo > 0 && harm > margin) status = "BREACH";
    else status = "UNCLEAR";
    const pctrl = r.pc;
    const needN = margin > 0 ? guardrailPerArm(pctrl, g.margin_rel) : NaN;
    return { ...g, r, harm, harmLo, harmHi, margin, status, needN, harmP: twoSidedP(r.adj / r.se) };
  });
  for (const g of guardResults) {
    const word = g.better === "down" ? "rise" : "fall";
    guard.items.push({
      label: g.label,
      status: g.status === "PASS" ? "pass" : g.status === "UNCLEAR" ? "warn" : "fail",
      detail: `${pct(g.r.pc, 2)} control, ${pct(g.r.pt, 2)} test (${relTxt(g.r.rel)}). Margin: a ${word} of at most ` +
        `${pts(g.margin, false)} points (${pct(g.margin_rel, 0)}). Harm 90% CI ${pts(g.harmLo)} to ${pts(g.harmHi)} points. ` + {
          PASS: "Harm beyond the margin is ruled out.",
          BREACH: "Harmed beyond the margin.",
          UNCLEAR: `Can't rule out harm beyond the margin; ruling it out needs about ${int(g.needN)} per arm.`,
        }[g.status],
    });
  }
  guard.status = guardResults.some((g) => g.status === "BREACH") ? "fail"
    : guardResults.some((g) => g.status === "UNCLEAR") ? "warn" : "pass";
  steps.push(guard);

  // Secondary metrics: shown, never decide
  const shown = (req.metrics || []).filter((m) => m.role === "secondary" && m.id !== primary.id);
  if (registered !== primary) shown.unshift({ ...registered, label: `${registered.label} (registered primary)` });
  const secondary = shown.map((m) => ({ ...m, r: propDiff(m.control, m.test, RULES.primaryZ) }));
  if (secondary.length) {
    steps.push({ key: "secondary", title: "What else moved? (explains, never decides)", status: "info",
      items: secondary.map((m) => ({ label: m.label + (m.den_kind === "subset" ? " (subset)" : ""), status: "info",
        detail: `${pct(m.r.pc, 2)} control, ${pct(m.r.pt, 2)} test: ${pts(m.r.diff)} points (${relTxt(m.r.rel)}), ` +
          `95% CI ${pts(m.r.lo)} to ${pts(m.r.hi)}, p = ${fmtP(m.r.p)}.` })) });
  }

  // 5. The call ---------------------------------------------------------------------------------------
  const breached = guardResults.filter((g) => g.status === "BREACH");
  const unclear = guardResults.filter((g) => g.status === "UNCLEAR");
  const lbl = (g) => lower(g.label);
  const list = (gs) => gs.map(lbl).join(" and ");
  const primTxt = `${lower(primary.label)} ${pts(pr.diff)} points (95% CI ${pts(pr.lo)} to ${pts(pr.hi)})`;
  let verdict, headline, next;

  if (trustFail) {
    verdict = "fix_data";
    const failed = trust.items.filter((i) => i.status === "fail");
    const srmFailed = failed.filter((i) => i.label.startsWith("Sample ratio"));
    const what = [];
    if (srmFailed.length) {
      what.push(`the arms aren't the planned ${pct(split, 0)} split` +
        (srmFailed.some((i) => i.label.endsWith("segment")) && worstSeg ? ` (worst in ${worstSeg.name})` : ""));
    }
    for (const i of failed.filter((x) => !x.label.startsWith("Sample ratio"))) what.push(`audit failed: ${lower(i.label)}`);
    headline = `Fix the data first: ${what.join("; ")}. Until the cause is found, no metric in this test can be trusted.`;
    const todo = [];
    if (srmFailed.length) {
      todo.push("Find what drops users from one arm before exposure is logged: a crash on launch, a redirect, a filter " +
        "or a slow-loading screen" + (worstSeg && worstSeg.p < RULES.srmFail ? `. Start with ${worstSeg.name}, where the gap is largest` : "") + ".");
    }
    const failedAudits = audits.filter((a) => a.status === "fail");
    if (failedAudits.some((a) => a.id === "partner_other_arm")) {
      todo.push("Partners are landing in different arms. Assign the variant per couple: the invitee inherits the " +
        "inviter's variant through the invite token.");
    }
    if (failedAudits.some((a) => a.id !== "partner_other_arm")) {
      const names = failedAudits.filter((a) => a.id !== "partner_other_arm").map((a) => `"${lower(a.label)}"`).join(" and ");
      todo.push(`Check the tracking behind ${names} in the test build: an event fired by the wrong screen, or fired ` +
        "twice, inflates one arm.");
    }
    next = todo.join(" ") + " Then fix and rerun; the numbers from this run can't be repaired.";
  } else if (!final) {
    const interimHarm = [];
    if (pr.p < RULES.interimHarmP && gain.est < 0) interimHarm.push(primary.label);
    for (const g of guardResults) if (g.harmP < RULES.interimHarmP && g.harm > g.margin) interimHarm.push(g.label);
    if (interimHarm.length) {
      verdict = "kill";
      headline = `Stop early: ${interimHarm.map(lower).join(" and ")} ${interimHarm.length > 1 ? "are" : "is"} clearly ` +
        `worse (p < ${RULES.interimHarmP}) before the test finished.`;
      next = "Turn the variant off and look at what caused the harm.";
    } else {
      verdict = "keep_running";
      headline = `Keep running. Day ${req.readout?.day ?? "?"} of a ${plan.days}-day plan, ${pct(sampleShare, 0)} of the ` +
        `planned sample. ${primary.label} is at ${pts(pr.diff)} points so far (p = ${fmtP(pr.p)}), but an early ` +
        `p-value isn't a result: stopping at the first p < 0.05 makes false wins several times likelier.`;
      next = `Read it again after day ${plan.days} with at least ${int(Math.ceil(RULES.doneShare * planned))} per arm. ` +
        "Only clear harm justifies stopping sooner.";
    }
  } else if (conditionalBlocked) {
    verdict = "iterate";
    headline = `No call on a subset metric. ${registered.label} is measured only on users who got through a step ` +
      "after assignment.";
    next = "Re-read the test with the same metric per assigned user (every user counted from exposure), then decide.";
  } else if (primaryClass === "WIN") {
    if (breached.length) {
      verdict = "iterate";
      headline = `It works, but at a cost: ${primTxt}, while ${list(breached)} ${breached.length > 1 ? "were" : "was"} ` +
        "harmed beyond the agreed margin.";
      next = `Keep what drives ${lower(primary.label)} and change what harms ${list(breached)} (frequency, timing, ` +
        "opt-out), then test the new version.";
    } else if (unclear.length) {
      verdict = "iterate";
      const most = unclear.reduce((m, g) => (g.needN > m.needN ? g : m));
      headline = `Promising, not proven safe: ${primTxt}, but the test can't rule out harm to ${list(unclear)} beyond ` +
        "the agreed margin.";
      next = `Extend the test until ${lbl(most)} is ruled out (about ${int(most.needN)} per arm in total), or ramp to a ` +
        `small share with an alarm on ${list(unclear)}.`;
    } else {
      verdict = "roll_out";
      headline = `Roll out: ${primTxt}` + (gain.est < mweAbs ? ", a real gain though smaller than the minimum worthwhile effect" : "") +
        ", and every guardrail is ruled out beyond its margin.";
      next = "Ramp to 100%. Keep a small holdback for a few weeks if the change is large, to confirm the effect lasts.";
    }
  } else if (primaryClass === "LOSS") {
    verdict = "kill";
    headline = `Kill: ${primTxt}. The variant makes the primary metric worse.`;
    next = "Keep control. Write down what the result says about the hypothesis before the next idea.";
  } else if (primaryClass === "FLAT") {
    verdict = "kill";
    headline = `Kill: ${primTxt}. The test rules out a gain of ${pts(mweAbs, false)} points or more, the ` +
      "minimum worth shipping.";
    next = "Keep control, the simpler product. The idea doesn't move the metric enough to be worth its cost.";
  } else if (breached.length) {
    verdict = "kill";
    headline = `Kill: no proven gain (${primTxt}), and ${list(breached)} ${breached.length > 1 ? "were" : "was"} harmed ` +
      "beyond the agreed margin.";
    next = "Keep control.";
  } else {
    verdict = "iterate";
    headline = `Can't tell yet: ${primTxt} is consistent with no effect and with the ${pts(mweAbs, false)}-point ` +
      "minimum worth shipping.";
    next = minArm >= RULES.doneShare * neededN
      ? "The test had the sample it needed and still can't separate zero from the minimum; a well-sized test lands " +
        "here about one time in five. Decide whether a rerun is worth it, or rethink the change so its effect is bigger."
      : `To settle it, rerun with about ${int(neededN)} per arm (this test had ${int(minArm)}), or rethink the change ` +
        "so its effect is bigger.";
  }
  if (registered !== primary && !trustFail && final) {
    const rr = propDiff(registered.control, registered.test, RULES.primaryZ);
    headline += ` The registered ${lower(registered.label)} moved ${relTxt(rr.rel)}, but that counts only users who ` +
      "got through a step the variant changed, so it rewards losing the weaker ones.";
  }
  steps.push({ key: "call", title: "The call", status: verdict, items: [] });

  return {
    version: VERSION,
    verdict,
    label: { roll_out: "Roll out", iterate: "Iterate", kill: "Kill", fix_data: "Fix the data first",
      keep_running: "Keep running" }[verdict],
    headline,
    next,
    steps,
    primary: { id: primary.id, label: primary.label, registered: registered.id, cls: primaryClass, mweAbs, ...pr, gain },
    guardrails: guardResults.map((g) => ({ id: g.id, label: g.label, status: g.status, harm: g.harm, harmLo: g.harmLo,
      harmHi: g.harmHi, margin: g.margin, pc: g.r.pc, pt: g.r.pt })),
    secondary: secondary.map((m) => ({ id: m.id, label: m.label, ...m.r })),
    srm: { overall, segments: segResults },
    audits: audits.map((a) => ({ id: a.id, label: a.label, status: a.status, rc: a.rc, rt: a.rt })),
    final,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Baselines the benchmark compares against

// The usual rule: read the registered primary as reported; ship if it is better at p < 0.05
export function naive(req) {
  const m = req.metrics.find((x) => x.role === "primary");
  const { p, z } = pooledP(m.control, m.test);
  const better = (z > 0) === (m.better === "up");
  if (p < 0.05) return better ? "roll_out" : "kill";
  return "iterate";
}

// The usual rule plus significance-based guardrails: don't ship if any guardrail is worse at p < 0.05
export function naiveGuard(req) {
  const v = naive(req);
  if (v !== "roll_out") return v;
  const hurt = req.metrics.filter((x) => x.role === "guardrail").some((g) => {
    const { p, z } = pooledP(g.control, g.test);
    return p < 0.05 && (z > 0) === (g.better === "down");
  });
  return hurt ? "iterate" : "roll_out";
}

// ---------------------------------------------------------------------------------------------------------
// Planner

// Users per arm for a guardrail to pass non-inferiority (one-sided 5%) with the given power, if it truly
// doesn't move. margin is relative to the baseline rate.
export function guardrailPerArm(baseline, marginRel, power = RULES.power) {
  const margin = marginRel * baseline;
  return Math.ceil(((RULES.guardZ + normInv(power)) ** 2) * 2 * baseline * (1 - baseline) / margin ** 2);
}

// params: { baseline, mweRel, alpha, power, dailyUsers (both arms), split (test share),
//           guardrails: [{ label, baseline, marginRel }] }
// A real winner ships only if it passes every check (the primary and each guardrail), so `power` is the chance
// of passing all of them. Each check gets power 1 - (1 - power) / (1 + guardrails), the correction in
// Schultzberg, Ankargren and Frånberg, "Risk-aware product decisions in A/B tests with multiple metrics"
// (Spotify, 2024). The recommended size is the largest any check needs: a test sized only for its primary
// often can't rule out harm on a rare-event guardrail such as crashes.
export function plan(params) {
  const { baseline, mweRel, alpha = 0.05, power = RULES.power, dailyUsers, split = 0.5 } = params;
  const checks = 1 + (params.guardrails || []).length;
  const each = 1 - (1 - power) / checks;
  const primaryOnlyN = perArm(baseline, mweRel, alpha, power);
  const primaryN = perArm(baseline, mweRel, alpha, each);
  const perDayPerArm = dailyUsers * Math.min(split, 1 - split);
  const toDays = (n) => (perDayPerArm > 0 ? Math.max(7, Math.ceil(n / perDayPerArm / 7) * 7) : Infinity);
  const guardrails = (params.guardrails || []).map((g) => ({ ...g, margin: g.marginRel * g.baseline,
    n: guardrailPerArm(g.baseline, g.marginRel, each) }));
  const driver = guardrails.reduce((d, g) => (g.n > d.n ? g : d), { label: "primary", n: primaryN });
  const recommendedN = driver.n;
  const days = toDays(recommendedN);
  const nAtDays = perDayPerArm * days;
  const za = normInv(1 - alpha / 2), zb = normInv(power);
  const mdeAbs = (za + zb) * Math.sqrt(2 * baseline * (1 - baseline) / nAtDays);
  for (const g of guardrails) {
    const se = Math.sqrt(2 * g.baseline * (1 - g.baseline) / nAtDays);
    g.passIfSafe = normCdf(g.margin / se - RULES.guardZ);   // chance it passes when truly unharmed
    g.maxObserved = g.margin - RULES.guardZ * se;           // largest observed harm that still passes
    const sePrimaryOnly = Math.sqrt(2 * g.baseline * (1 - g.baseline) / (perDayPerArm * toDays(primaryOnlyN)));
    g.passIfSafePrimaryOnly = normCdf(g.margin / sePrimaryOnly - RULES.guardZ);
  }
  return { primaryOnlyN, primaryN, powerEach: each, recommendedN, driver: driver.label, days,
    daysPrimaryOnly: toDays(primaryOnlyN), nAtDays, mdeAbs, mdeRel: mdeAbs / baseline, guardrails };
}
