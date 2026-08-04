# Sync hook stall on unreachable collector

> **RESOLVED**, but the fix proposed below is **not sufficient on its own** — it
> reduces the stall by nothing at all. Measured against a blackholed collector, the
> hook still took >120 s with `timeoutMillis: 3000` set exactly as written here.
> See [What it actually took](#what-it-actually-took).

**Severity:** Medium — UX: every session start and turn end can block for ~10s when
the collector is unreachable (laptop off the home network).
**Files:** `claude/src/bridge.ts` (`createMeterProvider`), `hooks.json`

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
- Consider making it configurable (`ATEL_TIMEOUT`, default 3000) only if someone
  actually reports a slow-but-reachable backend; start hardcoded.
- The pi extension exports on a background interval, so the default timeout is fine
  there — no change needed in `src/index.ts`.
- Optionally lower the sync hook timeouts in `hooks.json` (e.g. 5s) once the
  exporter is capped, so a pathological hang is bounded tighter.

## Acceptance

- With the collector endpoint pointed at a blackholed address, starting a Claude
  Code session and completing a turn feels instant (subjective: no visible pause;
  measurable: hook wall time ≤ ~3.5s, ideally verified with `ATEL_DEBUG=1`
  timestamps).
- With the collector reachable, metrics still arrive (run `demo/` stack and confirm
  on the dashboard).

## What it actually took

The plan assumed one exporter timeout governs the stall. Three separate things do,
and only the third is decisive. Measured with `ATEL_ENDPOINT` pointed at
`192.0.2.1` (TEST-NET-1, which blackholes rather than refusing):

**1. The reader's timeout, not the exporter's, is what fires.** The stall was ~30 s
per hook, not the ~10 s assumed here — that is
`PeriodicExportingMetricReader`'s `exportTimeoutMillis` default of `30000`, which
wraps the whole export cycle. `timeoutMillis` on `OTLPMetricExporter` only caps the
HTTP request inside it. Both are now set.

**2. `exportTimeoutMillis` must be clamped, not hardcoded.** The reader's
constructor *throws* if `exportTimeoutMillis > exportIntervalMillis`, and
`ATEL_EXPORT_INTERVAL` is user-settable with only a `> 0` check. A bare
`exportTimeoutMillis: 3000` would therefore throw for anyone running an interval
below 3 s — and `main()`'s catch would swallow it, silently disabling telemetry
instead of failing loudly. Hence
`Math.min(FLUSH_TIMEOUT_MS, config.exportIntervalMs)`.

**3. No timeout inside the SDK can fix this, because `forceFlush()` never settles.**
When the reader's timeout fires, `callWithTimeout` abandons the in-flight request
*without cancelling it*, and `onForceFlush` then still awaits
`exporter.forceFlush()` — which stays pending as long as the socket does. With both
timeouts above correctly set and firing at 3 s, `meterProvider.forceFlush()` was
still unsettled 50 s later. The teardown is therefore bounded by the bridge itself
(`settleWithin`), and `process.exit(0)` runs unconditionally afterwards, because a
connect attempt to an unreachable host keeps the event loop alive for the full TCP
SYN-retry window (~2 min on Linux) even once nothing is awaiting it.

Measured, three runs each:

| | before | after |
|---|---|---|
| collector blackholed | >120 s (killed) | **3.11 / 3.14 / 3.13 s** |
| collector reachable | 0.15 s | 0.15 s |

Acceptance met. The optional follow-ups were not taken: `hooks.json` timeouts are
unchanged, and the cap stays hardcoded rather than becoming `ATEL_TIMEOUT` — per
this plan's own advice, wait for a report of a slow-but-reachable backend.

The pi extension is unaffected: it exports on a background interval in a long-lived
process, so nothing there is on the user's critical path.
