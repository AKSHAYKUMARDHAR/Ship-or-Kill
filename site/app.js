import { readout, naive, naiveGuard, plan, VERSION } from "./shiporkill.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-");
const pts = (x) => { const v = x * 100; return (v > 0 ? "+" : "") + (Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1)); };
const pctTxt = (x, d = 0) => (x * 100).toFixed(d) + "%";
const VERDICT = { roll_out: "Roll out", iterate: "Iterate", kill: "Kill", fix_data: "Fix the data first", keep_running: "Keep running" };
const ICON = { pass: "✓", warn: "!", fail: "✕", info: "i" };
const FAMILY = {
  clean_win: "Clean win", clean_null: "No effect", clean_loss: "Clean loss", denominator_trap: "Denominator trap",
  guardrail_loud: "Guardrail harm, loud", srm_bug: "Sample ratio bug", tracking_bug: "Tracking bug", peeking: "Peeking",
  guardrail_quiet: "Guardrail harm, near the margin", split_couples: "Couples split across arms",
  underpowered_win: "Underpowered winner",
};
const FAMILY_ORDER = Object.keys(FAMILY);

let examples = [];
let bench = [];
let current = null;      // the request on screen
let currentMeta = null;  // example metadata (source, extra checks, kind)

// ---------------------------------------------------------------------------------------------------------
// Tabs

const TABS = ["read", "plan", "bench", "how"];
function showTab(name, push = true) {
  if (!TABS.includes(name)) name = "read";
  for (const t of TABS) {
    $(`#${t}`).hidden = t !== name;
    $(`#tab-${t}`).setAttribute("aria-selected", String(t === name));
  }
  if (push) history.replaceState(null, "", `#${name}`);
}
for (const t of TABS) $(`#tab-${t}`).addEventListener("click", () => showTab(t));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1), false));
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const i = TABS.findIndex((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true");
  const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  showTab(n);
  $(`#tab-${n}`).focus();
});

// ---------------------------------------------------------------------------------------------------------
// Readout

function validate(req) {
  const errs = [];
  if (!req.assigned || !(req.assigned.control > 0) || !(req.assigned.test > 0)) errs.push("Assigned users must be above zero in both arms.");
  const prim = (req.metrics || []).filter((m) => m.role === "primary");
  if (prim.length !== 1) errs.push("Mark exactly one metric as primary.");
  for (const m of req.metrics || []) {
    for (const a of ["control", "test"]) {
      const { num, den } = m[a] || {};
      if (!(den > 0) || !(num >= 0) || num > den) errs.push(`${m.label || m.id}: ${a} needs 0 ≤ count ≤ users, with users above zero.`);
    }
  }
  return errs;
}

function render() {
  const req = current;
  const card = $("#verdict");
  $("#hypothesis").textContent = req.hypothesis ? `Hypothesis: ${req.hypothesis}` : "";
  const errs = validate(req);
  if (errs.length) {
    card.className = "verdict-card";
    card.innerHTML = `<p class="headline"><b>Check the numbers:</b></p><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
    $("#chart").innerHTML = "";
    $("#steps").innerHTML = "";
    return;
  }
  let r;
  try {
    r = readout(req);
  } catch (e) {
    card.className = "verdict-card";
    card.innerHTML = `<p class="headline">Couldn't read this test: ${esc(e.message)}</p>`;
    return;
  }
  const nv = naive(req), ng = naiveGuard(req);
  card.className = `verdict-card ${r.verdict}`;
  card.innerHTML = `
    <div class="verdict-top"><span class="vbadge ${r.verdict}">${esc(ICON[{ roll_out: "pass", iterate: "warn", keep_running: "warn" }[r.verdict] || "fail"])} The call</span>
      <span class="verdict-label">${esc(r.label)}</span></div>
    <p class="headline">${esc(r.headline)}</p>
    <p class="next"><b>Next:</b> ${esc(r.next)}</p>
    <p class="versus">The usual rule (ship if the registered primary is up at p &lt; 0.05) would say <b>${esc(VERDICT[nv])}</b>;
      with a significance veto on guardrails, <b>${esc(VERDICT[ng])}</b>.</p>`;
  renderChart(r, req);
  renderSteps(r);
}

function rowsFor(r, req) {
  const byId = Object.fromEntries(req.metrics.map((m) => [m.id, m]));
  const rows = [];
  const p = r.primary;
  rows.push({ label: p.label, role: p.registered !== p.id ? "Primary, per assigned user" : "Primary", est: p.gain.est,
    lo: p.gain.lo, hi: p.gain.hi, thr: p.mweAbs, thrKind: "mwe",
    status: { WIN: "pass", INCONCLUSIVE: "warn", LOSS: "fail", FLAT: "fail" }[p.cls],
    word: { WIN: "Win", INCONCLUSIVE: "Can't tell", LOSS: "Worse", FLAT: "Too small" }[p.cls],
    tip: `${p.label}: ${pts(p.diff)} points, 95% CI ${pts(p.lo)} to ${pts(p.hi)}. Minimum worthwhile effect ${pts(p.mweAbs).replace("+", "")} points.` });
  for (const g of r.guardrails) {
    rows.push({ label: g.label, role: "Guardrail", est: -g.harm, lo: -g.harmHi, hi: -g.harmLo, thr: -g.margin, thrKind: "margin",
      status: { PASS: "pass", UNCLEAR: "warn", BREACH: "fail" }[g.status],
      word: { PASS: "Safe", UNCLEAR: "Can't rule out", BREACH: "Harmed" }[g.status],
      tip: `${g.label}: harm ${pts(g.harm)} points (90% CI ${pts(g.harmLo)} to ${pts(g.harmHi)}); margin ${pts(g.margin).replace("+", "")} points.` });
  }
  for (const s of r.secondary) {
    const better = byId[s.id]?.better || "up";
    const sg = better === "down" ? -1 : 1;
    rows.push({ label: s.label, role: "Explains, never decides", est: sg * s.diff, lo: sg > 0 ? s.lo : -s.hi,
      hi: sg > 0 ? s.hi : -s.lo, thr: null, status: "info", word: "Info",
      tip: `${s.label}: ${pts(s.diff)} points, 95% CI ${pts(s.lo)} to ${pts(s.hi)}.` });
  }
  return rows;
}

function renderChart(r, req) {
  const rows = rowsFor(r, req);
  const html = [`<div class="caxis" aria-hidden="true"><div></div><div><span>← worse</span><span>better →</span></div><div></div></div>`];
  rows.forEach((row, i) => {
    const m = Math.max(Math.abs(row.lo), Math.abs(row.hi), Math.abs(row.thr ?? 0), 1e-4) * 1.18;
    const x = (v) => Math.max(0, Math.min(100, 50 + 50 * (v / m)));
    const left = x(row.lo), right = x(row.hi);
    html.push(`<div class="crow" data-i="${i}" tabindex="0" aria-label="${esc(row.tip)} ${esc(row.word)}.">
      <div class="cname">${esc(row.label)}<span class="role">${esc(row.role)}</span></div>
      <div class="ctrack"><div class="base"></div><div class="zero" style="left:50%"></div>
        ${row.thr != null ? `<div class="thr ${row.thrKind}" style="left:${x(row.thr)}%"></div>` : ""}
        <div class="ci ${row.status}-c" style="left:${left}%;width:${Math.max(right - left, 0.6)}%"></div>
        <div class="dot ${row.status}-c" style="left:${x(row.est)}%"></div></div>
      <div class="cstat"><span class="icon ${row.status}" aria-hidden="true">${ICON[row.status]}</span>${esc(row.word)}</div></div>`);
  });
  const el = $("#chart");
  el.innerHTML = html.join("");
  const tip = $("#tooltip");
  el.querySelectorAll(".crow").forEach((rowEl) => {
    const row = rows[+rowEl.dataset.i];
    const show = (cx, cy) => {
      tip.textContent = row.tip;
      tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, cx + 12)) + "px";
      tip.style.top = Math.max(8, cy - h - 10) + "px";
    };
    rowEl.addEventListener("pointermove", (e) => show(e.clientX, e.clientY));
    rowEl.addEventListener("pointerleave", () => { tip.hidden = true; });
    rowEl.addEventListener("focus", () => { const b = rowEl.getBoundingClientRect(); show(b.left + b.width / 2, b.top); });
    rowEl.addEventListener("blur", () => { tip.hidden = true; });
  });
}

function renderSteps(r) {
  const parts = r.steps.filter((s) => s.key !== "call").map((s) => {
    const st = s.status === "info" ? "info" : s.status;
    return `<div class="step"><h3><span class="icon ${st}" aria-hidden="true">${ICON[st] || "i"}</span>${esc(s.title)}</h3>
      <ul class="items">${s.items.map((i) => `<li><span class="icon ${i.status}" aria-label="${esc(i.status)}">${ICON[i.status] || "i"}</span>
        <span><b>${esc(i.label)}.</b> ${esc(i.detail)}</span></li>`).join("")}</ul></div>`;
  });
  if (currentMeta && (currentMeta.source || currentMeta.extra_checks?.length)) {
    parts.push(`<div class="step"><h3><span class="icon info" aria-hidden="true">i</span>About this example</h3>
      ${currentMeta.source ? `<p class="small">${esc(currentMeta.source)}</p>` : ""}
      ${currentMeta.extra_checks?.length ? `<ul class="extra">${currentMeta.extra_checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}</div>`);
  }
  parts.push(`<p class="small">Engine ${esc(VERSION)}. The same file scored the benchmark.</p>`);
  $("#steps").innerHTML = parts.join("");
}

// ---------------------------------------------------------------------------------------------------------
// Form <-> request

const ROLES = [["primary", "Primary"], ["guardrail", "Guardrail"], ["secondary", "Secondary"]];

function metricRow(m) {
  const thr = m.role === "primary" ? m.mwe_rel : m.role === "guardrail" ? m.margin_rel : "";
  const tr = document.createElement("tr");
  tr.dataset.id = m.id;
  tr.innerHTML = `
    <td><input aria-label="Metric name" data-k="label" value="${esc(m.label)}"></td>
    <td><select aria-label="Role" data-k="role">${ROLES.map(([v, l]) => `<option value="${v}"${m.role === v ? " selected" : ""}>${l}</option>`).join("")}</select></td>
    <td><select aria-label="Better when" data-k="better"><option value="up"${m.better === "up" ? " selected" : ""}>Up</option>
      <option value="down"${m.better === "down" ? " selected" : ""}>Down</option></select></td>
    <td><input aria-label="Control count" type="number" min="0" data-k="cn" value="${m.control.num}"></td>
    <td><input aria-label="Control users" type="number" min="0" data-k="cd" value="${m.control.den}"></td>
    <td><input aria-label="Test count" type="number" min="0" data-k="tn" value="${m.test.num}"></td>
    <td><input aria-label="Test users" type="number" min="0" data-k="td" value="${m.test.den}"></td>
    <td><input aria-label="Threshold, percent relative" type="number" step="0.5" data-k="thr" value="${thr === "" || thr == null ? "" : +(thr * 100).toFixed(2)}"${m.role === "secondary" ? " disabled" : ""}></td>
    <td><input aria-label="Measured on a subset" type="checkbox" data-k="subset"${m.den_kind === "subset" ? " checked" : ""}></td>
    <td><button type="button" class="rm" aria-label="Remove metric">×</button></td>`;
  return tr;
}

function fillForm(req) {
  const p = req.plan || {};
  $("#f-per-arm").value = p.per_arm ?? "";
  $("#f-days").value = p.days ?? "";
  $("#f-enrolled").value = req.readout?.enrolment_days ?? "";
  $("#f-split").value = p.split ?? 0.5;
  $("#f-a-control").value = req.assigned.control;
  $("#f-a-test").value = req.assigned.test;
  const tb = $("#metrics-table tbody");
  tb.innerHTML = "";
  for (const m of req.metrics) tb.appendChild(metricRow(m));
  fillTwin(req);
  $("#json").value = JSON.stringify(req, null, 1);
}

function fillTwin(req) {
  const prim = req.metrics.find((m) => m.role === "primary");
  const show = prim && prim.den_kind === "subset";
  $("#twin-wrap").hidden = !show;
  if (!show) return;
  const opts = req.metrics.filter((m) => m !== prim && m.den_kind !== "subset");
  $("#f-twin").innerHTML = `<option value="">(none)</option>` + opts.map((m) =>
    `<option value="${esc(m.id)}"${prim.itt_twin === m.id ? " selected" : ""}>${esc(m.label)}</option>`).join("");
}

function readForm() {
  const num = (s) => { const v = $(s).value; return v === "" ? undefined : Number(v); };
  const req = structuredClone(current);
  req.plan = { ...req.plan, split: num("#f-split") ?? 0.5 };
  const per = num("#f-per-arm"), days = num("#f-days");
  if (per) req.plan.per_arm = per; else delete req.plan.per_arm;
  if (days) req.plan.days = days; else delete req.plan.days;
  const enrolled = num("#f-enrolled");
  req.readout = { ...(req.readout || {}) };
  if (enrolled != null) req.readout.enrolment_days = enrolled; else delete req.readout.enrolment_days;
  req.assigned = { control: num("#f-a-control") ?? 0, test: num("#f-a-test") ?? 0 };
  const twin = $("#f-twin").value;
  req.metrics = [...document.querySelectorAll("#metrics-table tbody tr")].map((tr) => {
    const g = (k) => tr.querySelector(`[data-k="${k}"]`);
    const role = g("role").value;
    const m = { id: tr.dataset.id, label: g("label").value, role, better: g("better").value,
      den_kind: g("subset").checked ? "subset" : "assigned",
      control: { num: Number(g("cn").value), den: Number(g("cd").value) },
      test: { num: Number(g("tn").value), den: Number(g("td").value) } };
    const thr = g("thr").value === "" ? undefined : Number(g("thr").value) / 100;
    if (role === "primary" && thr != null) m.mwe_rel = thr;
    if (role === "guardrail" && thr != null) m.margin_rel = thr;
    if (role === "primary" && m.den_kind === "subset" && twin) m.itt_twin = twin;
    return m;
  });
  return req;
}

let timer = null;
function onFormChange() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = readForm();
    fillTwin(current);
    $("#json").value = JSON.stringify(current, null, 1);
    render();
  }, 150);
}

$("#editor").addEventListener("input", (e) => { if (!e.target.closest("details.json")) onFormChange(); });
$("#metrics-table").addEventListener("change", (e) => {
  if (e.target.dataset.k === "role") {
    const thr = e.target.closest("tr").querySelector('[data-k="thr"]');
    thr.disabled = e.target.value === "secondary";
  }
  onFormChange();
});
$("#metrics-table").addEventListener("click", (e) => {
  if (!e.target.classList.contains("rm")) return;
  e.target.closest("tr").remove();
  onFormChange();
});
$("#add-metric").addEventListener("click", () => {
  const ids = new Set(current.metrics.map((m) => m.id));
  let k = 1;
  while (ids.has(`m${k}`)) k++;
  const m = { id: `m${k}`, label: "New metric", role: "secondary", better: "up", den_kind: "assigned",
    control: { num: 0, den: current.assigned.control }, test: { num: 0, den: current.assigned.test } };
  $("#metrics-table tbody").appendChild(metricRow(m));
  onFormChange();
});
$("#load-json").addEventListener("click", () => {
  try {
    const req = JSON.parse($("#json").value);
    if (!req.assigned || !Array.isArray(req.metrics)) throw new Error("needs \"assigned\" and \"metrics\"");
    req.plan ||= {}; req.segments ||= []; req.audits ||= []; req.days ||= [];
    setRequest(req, { kind: "custom" });
    $("#json-msg").textContent = "Read.";
  } catch (e) {
    $("#json-msg").textContent = `Not valid: ${e.message}`;
  }
});

function setRequest(req, meta = null) {
  current = structuredClone(req);
  currentMeta = meta;
  fillForm(current);
  $("#example-kind").textContent = meta?.kind === "public" ? "Public experiment, real data"
    : meta?.kind === "illustrative" ? "Illustrative numbers" : meta?.kind === "benchmark" ? "Simulated benchmark case" : "";
  render();
}

function blank() {
  const n = 10000;
  return { id: "blank", name: "Your test", hypothesis: "", plan: { per_arm: 10000, days: 14, split: 0.5, alpha: 0.05 },
    readout: { enrolment_days: 14 }, assigned: { control: n, test: n }, segments: [], days: [], audits: [],
    metrics: [
      { id: "d1", label: "D1 retention", role: "primary", better: "up", den_kind: "assigned", mwe_rel: 0.05,
        control: { num: 3000, den: n }, test: { num: 3150, den: n } },
      { id: "un", label: "Uninstalls within 48 h", role: "guardrail", better: "down", den_kind: "assigned", margin_rel: 0.12,
        control: { num: 850, den: n }, test: { num: 860, den: n } },
    ] };
}

$("#example").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "blank") return setRequest(blank(), { kind: "custom" });
  const ex = examples.find((x) => x.id === v);
  if (ex) setRequest(ex, ex);
  else {
    const c = bench.find((x) => `case:${x.id}` === v);
    if (c) setRequest(c.request, benchMeta(c));
  }
});

function benchMeta(c) {
  return { kind: "benchmark", source: `Benchmark case ${c.id} (${c.split === "holdout" ? "held-out" : "development"}), ` +
    `${FAMILY[c.family]}. What was really there: ${c.story} True label: ${c.class}${c.data_problem ? ", with a data problem" : ""}.` };
}

// ---------------------------------------------------------------------------------------------------------
// Planner

const GUARD_DEFAULTS = [["D1 retention", 30, 4], ["Uninstalls within 48 h", 8.5, 12], ["Users with a crash within 48 h", 2, 25]];
function guardRow([label, base, margin]) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input aria-label="Guardrail name" value="${esc(label)}"></td>
    <td><input aria-label="Control rate, percent" type="number" step="0.1" value="${base}"></td>
    <td><input aria-label="Margin, percent relative" type="number" step="0.5" value="${margin}"></td>
    <td><button type="button" class="rm" aria-label="Remove guardrail">×</button></td>`;
  return tr;
}
for (const g of GUARD_DEFAULTS) $("#guard-table tbody").appendChild(guardRow(g));
$("#add-guard").addEventListener("click", () => { $("#guard-table tbody").appendChild(guardRow(["New guardrail", 10, 10])); renderPlan(); });
$("#guard-table").addEventListener("click", (e) => { if (e.target.classList.contains("rm")) { e.target.closest("tr").remove(); renderPlan(); } });
$("#plan").addEventListener("input", () => renderPlan());

function renderPlan() {
  const v = (id) => Number($(id).value);
  const guardrails = [...document.querySelectorAll("#guard-table tbody tr")].map((tr) => {
    const [a, b, c] = tr.querySelectorAll("input");
    return { label: a.value, baseline: Number(b.value) / 100, marginRel: Number(c.value) / 100 };
  }).filter((g) => g.baseline > 0 && g.baseline < 1 && g.marginRel > 0);
  const params = { baseline: v("#p-base") / 100, mweRel: v("#p-mwe") / 100, dailyUsers: v("#p-daily"),
    split: v("#p-split"), alpha: v("#p-alpha"), power: v("#p-power"), guardrails };
  const out = $("#plan-out");
  const ok = params.baseline > 0 && params.baseline < 1 && params.mweRel > 0 && params.dailyUsers > 0 &&
    params.split > 0 && params.split < 1 && params.alpha > 0 && params.alpha < 0.5 && params.power > 0.5 && params.power < 1 &&
    params.baseline * (1 + params.mweRel) < 1;
  if (!ok) { out.innerHTML = `<p class="panel">Check the inputs: rates between 0 and 100%, power between 0.5 and 1.</p>`; return; }
  const p = plan(params);
  const name = $("#p-name").value || "the primary";
  const days = (d) => (Number.isFinite(d) ? `${d} days` : "never");
  out.innerHTML = `
    <div class="plan-tiles">
      <div class="plan-tile"><span class="small">Sized for the primary only (what most calculators give)</span>
        <b>${int(p.primaryOnlyN)} per arm</b><span class="small">${days(p.daysPrimaryOnly)} at ${int(params.dailyUsers)} a day</span></div>
      <div class="plan-tile main"><span class="small">Sized for every check</span>
        <b>${int(p.recommendedN)} per arm</b><span class="small">${days(p.days)}, set by ${esc(p.driver === "primary" ? name : p.driver)}</span></div>
      <div class="plan-tile"><span class="small">Smallest change in ${esc(name)} it can detect at that size</span>
        <b>${pctTxt(p.mdeRel, 1)} relative</b><span class="small">${pts(p.mdeAbs).replace("+", "")} points</span></div>
    </div>
    <section class="panel">
      <h2>Each check</h2>
      <p class="small">With ${p.guardrails.length} guardrail${p.guardrails.length === 1 ? "" : "s"}, each of the ${p.guardrails.length + 1}
        checks gets ${pctTxt(p.powerEach, 1)} power, so a real winner passes all of them about ${pctTxt(params.power)} of the time.
        "Passes if safe" is the chance a guardrail that truly doesn't move is confirmed safe.</p>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Check</th><th class="num">Needs per arm</th><th class="num">Margin</th>
          <th class="num">Passes if safe, primary-only size</th><th class="num">Passes if safe, recommended size</th></tr></thead>
        <tbody><tr><td>${esc(name)} (primary)</td><td class="num">${int(p.primaryN)}</td><td class="num">-</td><td class="num">-</td><td class="num">-</td></tr>
        ${p.guardrails.map((g) => `<tr><td>${esc(g.label)}</td><td class="num">${int(g.n)}</td>
          <td class="num">${pts(g.margin).replace("+", "")} pts</td><td class="num">${pctTxt(g.passIfSafePrimaryOnly)}</td>
          <td class="num">${pctTxt(g.passIfSafe)}</td></tr>`).join("")}</tbody></table></div>
      <p class="small">Tight margins on rare events are expensive: halving a margin needs four times the users. If the
        recommended size is out of reach, widen a margin you can live with, or watch that metric during a staged ramp
        instead of gating the test on it.</p>
    </section>`;
}

// ---------------------------------------------------------------------------------------------------------
// Benchmark

function outcome(c, v) {
  if (c.data_problem) return v === "fix_data" ? "right" : "wrong";
  if (v === "fix_data") return "wrong";
  if (c.class === "winner") return v === "roll_out" ? "right" : v === "kill" ? "wrong" : "missed";
  return v === "roll_out" ? "wrong" : "right";
}

function stats(cases, rule) {
  const f = (pred, base) => { const b = cases.filter(base); return [b.filter((c) => pred(c.frozen[rule])).length, b.length]; };
  return {
    wrong: f((v) => v === "roll_out", (c) => c.class !== "winner"),
    harmful: f((v) => v === "roll_out", (c) => c.class === "harmful"),
    caught: f((v) => v === "fix_data", (c) => c.data_problem),
    alarms: f((v) => v === "fix_data", (c) => !c.data_problem),
    killed: f((v) => v === "kill", (c) => c.class === "winner"),
    missed: f((v) => v !== "roll_out", (c) => c.class === "winner" && !c.data_problem),
  };
}
const frac = ([n, d]) => `${n}/${d}`;
const share = ([n, d]) => (d ? ` (${Math.round((100 * n) / d)}%)` : "");

function renderScores() {
  const h = bench.filter((c) => c.split === "holdout");
  const s = stats(h, "verdict"), n = stats(h, "naive");
  const tile = (big, text) => `<div class="score"><b>${big}</b><span>${text}</span></div>`;
  $("#scores").innerHTML = [
    tile(frac(s.wrong), `non-winners rolled out by Ship or Kill. The usual rule: ${frac(n.wrong)}${share(n.wrong)}`),
    tile(frac(s.caught), `broken tests caught (sample ratio, tracking, split couples). The usual rule: ${frac(n.caught)}`),
    tile(frac(s.missed), `real winners held back: the cost of caution. The usual rule: ${frac(n.missed)}`),
    tile("Gate passed", "release gate on the held-out set, run once; the hypothesis's cost limit was missed"),
  ].join("");
  $("#score-note").textContent = "Held-out release run: 88 simulated couples-app tests with known true effects, run once with the engine frozen. Simulated, not real users; see the Benchmark tab for what that can and can't show.";
}

function renderBenchTables() {
  const split = $("#b-split").value;
  const cs = bench.filter((c) => c.split === split);
  const rules = [["verdict", "Ship or Kill"], ["naive", "Usual rule (primary p &lt; 0.05)"], ["naive_guard", "Usual rule + guardrail veto"]];
  const st = Object.fromEntries(rules.map(([k]) => [k, stats(cs, k)]));
  const rowsDef = [["wrong", "Non-winners rolled out"], ["harmful", "Harmful variants rolled out"], ["caught", "Broken tests caught"],
    ["alarms", "False data alarms"], ["killed", "Real winners killed"], ["missed", "Real winners held back (clean data)"]];
  $("#b-summary").innerHTML = `<thead><tr><th></th>${rules.map(([, l]) => `<th class="num">${l}</th>`).join("")}</tr></thead>
    <tbody>${rowsDef.map(([k, l]) => `<tr><td>${l}</td>${rules.map(([r], i) => `<td class="num${i === 0 ? " us" : ""}"><b>${frac(st[r][k])}</b>${share(st[r][k])}</td>`).join("")}</tr>`).join("")}</tbody>`;
  const short = { roll_out: "roll out", iterate: "iterate", kill: "kill", keep_running: "keep running", fix_data: "fix data" };
  const fams = FAMILY_ORDER.filter((f) => cs.some((c) => c.family === f));
  $("#b-family").innerHTML = `<thead><tr><th>Case type</th><th>Truth</th><th class="num">n</th>${rules.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead>
    <tbody>${fams.map((f) => {
      const rs = cs.filter((c) => c.family === f);
      const cell = (k) => Object.keys(short).map((v) => [v, rs.filter((c) => c.frozen[k] === v).length])
        .filter(([, n]) => n).map(([v, n]) => `${short[v]} ${n}`).join(", ");
      return `<tr><td>${FAMILY[f]}${["guardrail_quiet", "split_couples", "underpowered_win"].includes(f) ? " <span class=\"small\">(held-out only)</span>" : ""}</td>
        <td>${rs[0].class}${rs[0].data_problem ? ", data problem" : ""}</td><td class="num">${rs.length}</td>
        ${rules.map(([k], i) => `<td${i === 0 ? ' class="us"' : ""}>${cell(k)}</td>`).join("")}</tr>`;
    }).join("")}</tbody>`;
  const sel = $("#b-fam");
  const keep = sel.value;
  sel.innerHTML = `<option value="all">Any</option>` + fams.map((f) => `<option value="${f}">${FAMILY[f]}</option>`).join("");
  sel.value = fams.includes(keep) ? keep : "all";
  renderBenchList();
}

function renderBenchList() {
  const split = $("#b-split").value, fam = $("#b-fam").value, oc = $("#b-outcome").value;
  const cs = bench.filter((c) => c.split === split && (fam === "all" || c.family === fam) &&
    (oc === "all" || outcome(c, c.frozen.verdict) === oc));
  $("#b-count").textContent = `${cs.length} case${cs.length === 1 ? "" : "s"}`;
  const label = { right: "right", missed: "too cautious", wrong: "wrong" };
  $("#b-list").innerHTML = cs.map((c) => {
    const o = outcome(c, c.frozen.verdict);
    return `<article class="card"><div class="card-top"><span class="cid">${c.id}</span><span class="tag">${FAMILY[c.family]}</span>
      <span class="tag">truth: ${c.class}${c.data_problem ? ", data problem" : ""}</span><span class="tag ${o}">Ship or Kill: ${label[o]}</span></div>
      <h3>${esc(c.request.name)}</h3><p>${esc(c.story)}</p>
      <div class="calls"><div><span>Ship or Kill</span><b>${VERDICT[c.frozen.verdict]}</b></div>
        <div><span>Usual rule</span>${VERDICT[c.frozen.naive]}</div><div><span>Usual rule + guardrail veto</span>${VERDICT[c.frozen.naive_guard]}</div></div>
      <button type="button" class="btn" data-open="${c.id}">Open in the readout</button></article>`;
  }).join("");
}
$("#b-split").addEventListener("change", renderBenchTables);
$("#b-fam").addEventListener("change", renderBenchList);
$("#b-outcome").addEventListener("change", renderBenchList);
$("#b-list").addEventListener("click", (e) => {
  const id = e.target.dataset?.open;
  if (!id) return;
  const c = bench.find((x) => x.id === id);
  ensureCaseOption(c);
  $("#example").value = `case:${c.id}`;
  setRequest(c.request, benchMeta(c));
  showTab("read");
  window.scrollTo({ top: $("#read").offsetTop - 10, behavior: "smooth" });
});

function ensureCaseOption(c) {
  if ([...$("#example").options].some((o) => o.value === `case:${c.id}`)) return;
  const grp = $("#example").querySelector('optgroup[label="Benchmark cases you opened"]') || (() => {
    const g = document.createElement("optgroup"); g.label = "Benchmark cases you opened"; $("#example").appendChild(g); return g;
  })();
  const o = document.createElement("option");
  o.value = `case:${c.id}`;
  o.textContent = `${c.id}: ${c.request.name} (${FAMILY[c.family]})`;
  grp.appendChild(o);
}

// ---------------------------------------------------------------------------------------------------------
// Start

async function start() {
  const [ex, bm] = await Promise.all([fetch("data/examples.json").then((r) => r.json()), fetch("data/benchmark.json").then((r) => r.json())]);
  examples = ex.examples;
  bench = bm.cases;
  $("#example").innerHTML = `<optgroup label="Worked examples">${examples.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</optgroup>
    <optgroup label="Your own"><option value="blank">Start from a blank test</option></optgroup>`;
  setRequest(examples[0], examples[0]);
  renderScores();
  renderBenchTables();
  renderPlan();
  showTab(location.hash.slice(1) || "read", false);
}
start().catch((e) => { $("#verdict").textContent = `Couldn't load the page data: ${e.message}`; });
