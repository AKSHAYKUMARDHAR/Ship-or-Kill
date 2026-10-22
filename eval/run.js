// Run the engine and the two baselines on a benchmark split. Reads only each case's `request`.
//   node eval/run.js dev            -> eval/results/dev.json
//   node eval/run.js holdout        -> eval/results/holdout.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../site/shiporkill.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const split = process.argv[2] || "dev";
const out = process.argv[3] || join(root, "eval", "results", `${split}.json`);
const engineSrc = readFileSync(join(root, "site", "shiporkill.js"));
const engineHash = createHash("sha256").update(engineSrc).digest("hex").slice(0, 12);
const cases = JSON.parse(readFileSync(join(root, "data", "benchmark", `${split}.json`), "utf8")).cases;

const rows = cases.map(({ id, request }) => {
  const r = engine.readout(request);
  return {
    id, verdict: r.verdict, naive: engine.naive(request), naive_guard: engine.naiveGuard(request),
    headline: r.headline, next: r.next, primary: r.primary.cls,
    guardrails: Object.fromEntries(r.guardrails.map((g) => [g.id, g.status])),
    trust: r.steps.find((s) => s.key === "trust").items.filter((i) => i.status !== "pass").map((i) => i.label),
  };
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ split, engine_version: engine.VERSION, engine_sha256: engineHash, rows }, null, 1) + "\n");
console.log(`${split}: ${rows.length} cases, engine ${engine.VERSION} (${engineHash}) -> ${out}`);
