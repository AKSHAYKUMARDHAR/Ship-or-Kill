// Prints engine statistics for a fixed grid of inputs, for tests/test_stats.py to check against scipy.
import * as E from "../site/shiporkill.js";
const out = { normInv: [], normSf: [], perArm: [], srm: [], propDiff: [], pooled: [] };
for (const p of [0.001, 0.01, 0.025, 0.05, 0.2, 0.5, 0.8, 0.95, 0.975, 0.995, 0.9999]) out.normInv.push([p, E.normInv(p)]);
for (const z of [-3, -1.5, 0, 0.5, 1.645, 1.96, 2.576, 3.29, 4.5, 6]) out.normSf.push([z, E.normSf(z)]);
for (const [p, r] of [[0.3, 0.05], [0.25, 0.08], [0.62, 0.06], [0.02, 0.25], [0.1, 0.1]]) out.perArm.push([p, r, E.perArm(p, r)]);
for (const [c, t, s] of [[44700, 45489, 0.5], [5000, 5000, 0.5], [7666, 7115, 0.5], [1000, 1100, 0.5], [3000, 7000, 0.7]]) out.srm.push([c, t, s, E.srm(c, t, s).p]);
for (const [xc, nc, xt, nt] of [[2550, 10000, 2594, 10000], [12, 400, 30, 410], [0, 50, 3, 50], [8501, 44700, 8279, 45489]]) {
  const r = E.propDiff({ num: xc, den: nc }, { num: xt, den: nt });
  out.propDiff.push([xc, nc, xt, nt, r.lo, r.hi, r.p]);
  out.pooled.push([xc, nc, xt, nt, E.pooledP({ num: xc, den: nc }, { num: xt, den: nt }).p]);
}
console.log(JSON.stringify(out));
