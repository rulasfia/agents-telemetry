# pi extension (`pi-coding-agent`)

The long-lived emitter. `pi-coding-agent` loads this module **directly from
TypeScript source** and keeps it alive for the whole session, so it can hold a
single `MeterProvider`, accumulate cumulative counters in memory, and time
things by holding start timestamps between events.

For installation and environment-variable reference, see the [root
README](../README.md). This document is about how the code works.

## Architecture at a glance

One process, one `MeterProvider`, held open for the session. Handlers only touch
in-memory instruments; a background reader ships them on a timer.

```
   user prompt
        |
        v
   pi-coding-agent          emits: session_start, turn_start, input,
        |                          tool_execution_start / _end, turn_end,
        |                          model_select, session_shutdown
        v
  +----------------------------------------------------------------+
  |  pi/src/index.ts -- event handlers                             |
  |  gate on ATEL_PI, build the pipeline, subscribe                |
  +------------------------------+---------------------------------+
                                 |  collector.record*()
                                 v
  +----------------------------------------------------------------+
  |  pi/src/telemetry.ts                                           |
  |    instruments   7 counters + 3 histograms                     |
  |    timers        sessionStart, turnStart, toolStartTimes{}     |
  |    status        hand-kept mirror, read by /otlp-status        |
  +------------------------------+---------------------------------+
                                 |  cumulative, held in this process
                                 v
                  PeriodicExportingMetricReader
                                 |  OTLP/HTTP every 60s,
                                 |  plus a final flush on shutdown
                                 v
                  OTel Collector ---> Prometheus ---> Grafana
```

## Data flow through one session

Indentation is nesting: a turn lives inside the session, a tool call inside the
turn. Left column is the pi event, right column is what leaves the process.

```
session_start                                    pi.session.count +1
|   save sessionStartTime, provider, model
|
+-- turn_start                                   pi.turn.count +1
|   |   save turnStartTime
|   |
|   +-- input {text}                             pi.prompt.count +1
|   |       (prompt.length attribute)
|   |
|   +-- tool_execution_start {toolCallId}        pi.tool_call.count +1
|   |   |   toolStartTimes[toolCallId] = now
|   |   |
|   |   +-- tool_execution_end {isError}         pi.tool_result.count +1
|   |           now - saved start                pi.tool.duration
|   |
|   +-- turn_end {message.usage}                 pi.turn.duration
|           usage + cost computed by pi          pi.token.usage   x4 types
|                                                pi.cost.usage    x4 types
|
+-- session_shutdown                             pi.session.duration
        meterProvider.shutdown()                 -> final flush, then exit

meanwhile, independent of all of the above:
    PeriodicExportingMetricReader ---> whole cumulative snapshot, every 60s
```

What each step actually does:

- **Counters are added to immediately; durations are deferred.** A `*_start`
  event only stores `Date.now()` — the metric is not emitted until the matching
  `*_end` arrives, and only if that start was seen. An unpaired end is dropped.
- **Nothing is sent at event time.** Handlers mutate in-process state; the
  reader exports the whole cumulative snapshot on its own timer. That is why an
  export interval of 60s (the default) means up to a minute of lag, and why
  `session_shutdown` matters — see [Shutdown and flushing](#shutdown-and-flushing).
- **Token and cost data arrive attached to the assistant message** on `turn_end`,
  already computed by pi. No transcript parsing, and cost is available — both
  unlike the Claude bridge.
- The relative order of `input` and `turn_start` is pi's business; the extension
  doesn't depend on it. Only start/end pairing matters.

## Files

| File | Role |
|------|------|
| `src/index.ts` | Entry point. Reads config, builds the OTel pipeline, subscribes to pi events, registers `/otlp-status`. |
| `src/telemetry.ts` | `createTelemetryCollector(meter)` — owns every instrument, all timing state, and the in-memory status mirror. Knows nothing about pi. |
| `src/config.ts` | Env-var parsing. **Shared with the Claude bridge** (`claude/src/bridge.ts` imports it). |
| `test/verify/` | Unit tests plus runnable demo scripts. |

The entry point is declared in the root `package.json` under
`"pi".extensions` → `pi/src/index.ts`. There is **no build step** — edit the
source and run pi's `/reload`.

## Startup sequence

`src/index.ts` exports a default function that pi calls once with the
`ExtensionAPI`:

1. `getConfig("pi")`. If `ATEL_PI !== "1"`, return immediately — nothing is
   registered, not even the `/otlp-status` command.
2. If `ATEL_DEBUG=1`, install a `FileDiagLogger` writing to
   `~/.pi/otlp-debug.log`. OTel's default diag logger writes to the console,
   which would paint over pi's TUI — hence the file.
3. Build the `Resource`: `service.name=pi-coding-agent`, `service.version`,
   `os.type`, `host.arch`, and `device.name` when `ATEL_DEVICE_NAME` is set.
4. Build one `PeriodicExportingMetricReader` per entry in
   `config.exporters` (`console` and/or `otlp`). **If neither matches, return** —
   a `MeterProvider` with zero readers would silently drop everything.
5. Create the `MeterProvider`, set it as the global provider, take a meter named
   `com.pi.otlp`, and hand it to `createTelemetryCollector`.
6. Subscribe to events and register the command.

Temporality is the SDK default, **cumulative**. That is correct here precisely
because the process is long-lived; the Claude bridge cannot do this and uses
delta instead (see [`claude/README.md`](../claude/README.md)).

## Event → metric mapping

These are the event names `src/index.ts` actually subscribes to.

| pi event | Collector call | Metrics emitted |
|----------|----------------|-----------------|
| `session_start` | `recordSessionStart` | `pi.session.count` +1; stores session start time |
| `session_shutdown` | `recordSessionEnd` then `shutdown()` | `pi.session.duration`; flushes and tears down the `MeterProvider` |
| `turn_start` | `recordTurnStart` | `pi.turn.count` +1; stores turn start time |
| `turn_end` | `recordTurnEnd` + `recordUsage` | `pi.turn.duration`; `pi.token.usage` and `pi.cost.usage` (4 `type`s each) when the message carries `usage` |
| `tool_execution_start` | `recordToolCall` | `pi.tool_call.count` +1; stores tool start time |
| `tool_execution_end` | `recordToolResult` | `pi.tool_result.count` +1; `pi.tool.duration` |
| `input` | `recordUserPrompt` | `pi.prompt.count` +1 |
| `model_select` | `setProviderModel` | none — relabels subsequent metrics |

Token and cost figures come straight off the assistant message's `usage` object
on `turn_end`; pi computes them, so unlike the Claude bridge this extension does
not need to parse a transcript and **does** emit `pi.cost.usage`.

### Attributes

Every instrument carries `session.id`, `provider`, `model` (`getBaseAttrs()`),
plus:

- `tool.name` on the tool metrics, and `success` (a stringified boolean) on
  `pi.tool_result.count` / `pi.tool.duration`;
- `type` (`input` / `output` / `cache_read` / `cache_write`) on
  `pi.token.usage` and `pi.cost.usage`;
- `prompt.length` on `pi.prompt.count` — the raw character count, which is
  effectively unbounded cardinality. See
  [plan 05](../docs/plans/05-minor-improvements.md).

## State held in the collector

`createTelemetryCollector` closes over everything; there is no external store.

- **Timing.** `sessionStartTime` and `turnStartTime` are single slots — a
  duration is only recorded if the matching start fired, and each is nulled
  after recording so a stray `turn_end` cannot double-count.
- **Tool timing.** `toolStartTimes` is a `Map` keyed by
  `toolCallId ?? toolName`. The id keeps parallel tool calls from stealing each
  other's start time; the name fallback exists for callers that omit the id, and
  in that case concurrent calls to the same tool *will* collide.
- **Provider/model.** Tracked in `src/index.ts` and mirrored into the collector.
  Three sources update it: `ctx.model` at `session_start`, the `model_select`
  event, and `ctx.model` on every `input` (a cheap resync for model switches
  that arrive by some other path). Defaults to `"unknown"`.
- **`status`.** A plain object mirroring every counter, updated alongside each
  instrument. This exists *only* for `/otlp-status` — the OTel SDK gives no way
  to read a counter back, so the extension keeps its own tally. Anything you add
  to the instruments should be added here too, or the command drifts from what
  is exported. `getStatus()` returns a deep-ish copy so callers can't mutate it.

Module-level singletons (`collector`, `meterProvider`) mean one active instance
per process; loading the extension twice would clobber the first.

## Shutdown and flushing

`session_shutdown` calls `meterProvider.shutdown()`, which forces a final export.
Without it, anything accumulated since the last periodic export — up to
`ATEL_EXPORT_INTERVAL`, **default 60s** — is lost when pi exits. Short
sessions therefore depend on this handler firing. Lower the interval (e.g.
`ATEL_EXPORT_INTERVAL=10000`) when developing so you don't wait a minute
to see data.

## Gotchas

- **`ATEL_EXPORTERS` defaults to `otlp`.** It used to default to `console`,
  which meant one environment got you OTLP from the Claude bridge but *console*
  from pi — no OTLP export, and console output painted underneath the TUI. That
  gap ([plan 03](../docs/plans/03-shared-config-exporter-gap.md)) is closed. Set
  `ATEL_EXPORTERS=console` if you actually want console output, and expect it to
  land on top of the TUI.
- **`src/config.ts` is shared.** Any change to it affects the Claude bridge and
  requires `npm run build:claude` before that side sees it.
- Config tests strip `ATEL_*` in `beforeEach`; if you add a new env var, keep it
  in that namespace or add it to the strip list, or your local shell will leak
  into assertions.

## Verifying changes

```bash
npm run typecheck
npx vitest run pi/src/config.test.ts pi/test/verify/telemetry.test.ts
```

The unit tests mock the OTLP SDK, so a green suite does **not** prove a metric
reaches a backend. For that, use the dev stack:

```bash
npm run dev:up       # collector on 4418, isolated from a real one on 4318
npm run dev:pi       # 3-turn session through this extension
npm run dev:metrics  # compare against the totals the harness printed
```

`scripts/dev-pi-session.ts` drives the real event names listed above.
`test/verify/integration-demo.ts` is older and emits `tool_call` / `tool_result`,
which nothing subscribes to — its tool metrics are silent no-ops. Prefer
`dev:pi`.
