# Sync hook stall on unreachable collector

**Severity:** Medium — UX: every session start and turn end can block for ~10s when
the collector is unreachable (laptop off the home network).
**Files:** `claude-plugin/src/bridge.ts` (`createMeterProvider`), `hooks.json`

## Problem

`SessionStart`, `Stop`, and `SessionEnd` hooks run **synchronously** — correctly so,
per the hooks.json rationale: they can be immediately followed by process exit, which
would kill a backgrounded hook before it flushes. But:

- `OTLPMetricExporter`'s default request timeout is ~10s,
- the hook timeouts are 10s (15s for SessionEnd),

so when `http://homeserver:4318` is unreachable, `forceFlush()` in the bridge waits
out the full exporter timeout and the user's session start / every turn end stalls
for up to 10 seconds. Telemetry should never be felt in the session.

## Fix

Cap the exporter's timeout well below the hook timeout in `createMeterProvider`:

```ts
new OTLPMetricExporter({
  url: config.otlpEndpoint,
  headers: config.otlpHeaders,
  temporalityPreference: AggregationTemporalityPreference.DELTA,
  timeoutMillis: 3000,
}),
```

Notes:

- 2–3s is enough for a LAN/tailnet collector; losing a datapoint beats a stalled
  prompt. Do not add retries.
- Consider making it configurable (`PI_OTLP_TIMEOUT`, default 3000) only if someone
  actually reports a slow-but-reachable backend; start hardcoded.
- The pi extension exports on a background interval, so the default timeout is fine
  there — no change needed in `src/index.ts`.
- Optionally lower the sync hook timeouts in `hooks.json` (e.g. 5s) once the
  exporter is capped, so a pathological hang is bounded tighter.

## Acceptance

- With the collector endpoint pointed at a blackholed address, starting a Claude
  Code session and completing a turn feels instant (subjective: no visible pause;
  measurable: hook wall time ≤ ~3.5s, ideally verified with `PI_OTLP_DEBUG=1`
  timestamps).
- With the collector reachable, metrics still arrive (run `demo/` stack and confirm
  on the dashboard).
