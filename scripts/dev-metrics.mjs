#!/usr/bin/env node
/**
 * Compact view of what the dev collector is holding.
 *
 *   npm run dev:metrics              # cumulative totals, Prometheus-side
 *   npm run dev:metrics -- --raw     # per-export deltas straight from the emitter
 *
 * The Prometheus endpoint repeats ~10 resource labels on every series, which
 * makes raw `curl` output unreadable. This drops the constant ones and keeps
 * the attributes that actually vary between data points.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const useRaw = process.argv.includes("--raw");
const endpoint = process.env.DEV_PROM_ENDPOINT ?? "http://localhost:8890/metrics";

// Constant per-process labels — noise once you have more than one series.
// service_name is deliberately kept: it is the only thing distinguishing the
// pi extension (pi-coding-agent) from the Claude bridge (pi-otlp-claude),
// which emit identical metric names.
const NOISE = new Set([
  "job",
  "host_arch",
  "os_type",
  "service_version",
  "otel_scope_name",
  "otel_scope_version",
  "otel_scope_schema_url",
  "telemetry_sdk_language",
  "telemetry_sdk_name",
  "telemetry_sdk_version",
]);

function shortenLabels(labelStr) {
  const kept = [];
  // Values can contain commas, so split on `,name="` boundaries only.
  for (const part of labelStr.split(/,(?=[a-zA-Z_][a-zA-Z0-9_]*=")/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    if (NOISE.has(key)) continue;
    kept.push(part);
  }
  return kept.join(",");
}

async function showCumulative() {
  let text;
  try {
    const res = await fetch(endpoint);
    text = await res.text();
  } catch {
    console.error(`Cannot reach ${endpoint}. Is the dev stack up? (npm run dev:up)`);
    process.exit(1);
  }

  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("pi_")) continue;
    // Metric names are not all lowercase — the cost counter renders as
    // pi_cost_usage_USD_total once the unit suffix is applied.
    const match = line.match(/^([A-Za-z_0-9]+)\{(.*)\}\s+(\S+)$/);
    if (!match) continue;
    const [, name, labels, value] = match;
    // Bucket rows are noise in a terminal summary; _count/_sum carry the signal.
    if (labels.includes('le="') && !line.includes("+Inf")) continue;
    rows.push({ name, labels: shortenLabels(labels), value });
  }

  if (rows.length === 0) {
    console.log("No pi_* metrics yet. Run `npm run dev:replay` first.");
    return;
  }

  rows.sort((a, b) => a.name.localeCompare(b.name) || a.labels.localeCompare(b.labels));
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    console.log(`${r.name.padEnd(width)}  ${String(r.value).padStart(10)}  ${r.labels}`);
  }
}

function showRaw() {
  const path = join(repoRoot, "stack", "dev-out", "raw.jsonl");
  let lines;
  try {
    lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    console.error(`No ${path}. Is the dev stack up and has anything been sent?`);
    process.exit(1);
  }

  console.log(`${lines.length} export(s) in raw.jsonl\n`);
  lines.forEach((line, i) => {
    const payload = JSON.parse(line);
    console.log(`--- export #${i + 1} ---`);
    for (const rm of payload.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const body = m.sum ?? m.histogram ?? m.gauge ?? {};
          const kind = m.sum ? "sum" : m.histogram ? "histogram" : "gauge";
          const temp =
            body.aggregationTemporality === 1
              ? "delta"
              : body.aggregationTemporality === 2
                ? "cumulative"
                : "";
          for (const p of body.dataPoints ?? []) {
            const attrs = (p.attributes ?? [])
              .map((a) => `${a.key}=${Object.values(a.value ?? {})[0]}`)
              .join(" ");
            const value =
              p.asDouble ?? p.asInt ?? (p.count !== undefined ? `count=${p.count} sum=${p.sum}` : "");
            console.log(`  ${m.name} [${kind}${temp ? "/" + temp : ""}] ${value}  ${attrs}`);
          }
        }
      }
    }
  });
}

if (useRaw) showRaw();
else await showCumulative();
