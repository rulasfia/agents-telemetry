# Claude Code plugin (`pi-otlp`)

The short-lived emitter. Claude Code runs each hook as its own process, so this
plugin is **not** a running service — it is a script that Claude Code spawns
fresh for every lifecycle event, reads one JSON payload from stdin, emits a
handful of data points, flushes, and exits. Every design decision below follows
from that.

For installation and environment-variable reference, see the [root
README](../README.md). This document is about how the code works.

## Architecture at a glance

No process outlives an event. Everything that has to survive between events —
timers, the resolved model, how far the transcript has been read — lives on
disk, and everything that has to be summed across processes is summed by the
collector.

```
   user prompt
        |
        v
   Claude Code
        |  spawns one process per hook event, event JSON on stdin
        v
  +---------------------------------------------------------------+
  |  bridge.js -- one short-lived process per hook event          |
  |                                                               |
  |    1. parse the event JSON from stdin                         |
  |    2. switch on hook_event_name, stage metric closures        |
  |    3. build a MeterProvider only if something was staged      |
  |    4. forceFlush, shutdown, exit 0 -- always                  |
  |                                                               |
  |  reads + writes   ~/.pi/otlp-claude/<session-id>.json         |
  |                     timers, provider/model, transcriptOffset  |
  |  reads tail of    transcript .jsonl                           |
  |                     token usage, resolved model id            |
  +------------------------------+--------------------------------+
                                 |  OTLP/HTTP, DELTA temporality
                                 v
                  +-------------------------------+
                  |  OTel Collector               |
                  |  deltatocumulative            | <-- pi extension
                  +---------------+---------------+     (cumulative)
                                  |
                                  v
                          Prometheus ---> Grafana
```

## Data flow through one session

Each box below is a **separate OS process**, spawned by Claude Code and gone
again before the next one starts. Nothing is shared between them except the
state file and the transcript on disk.

```
+-- SessionStart --------------------------------- sync, 10s ----+
|  state:  prune files older than 7d                             |
|          write sessionStartTime, provider/model, offset = 0    |
|  emit:   pi.session.count                                      |
+----------------------------------------------------------------+
      |  process exits. the state file is now the only memory.
      v
===== repeats once per turn =====================================

+-- UserPromptSubmit ---------------------------- async, 10s ----+
|  state:  write turnStartTime                                   |
|  emit:   pi.prompt.count            (prompt.length attribute)  |
+----------------------------------------------------------------+
      |
      |  Claude Code: provider replies with a tool request
      |               (assistant msg is appended to the transcript),
      |               then the tool actually runs
      v
+-- PostToolUse / PostToolUseFailure ------------ async, 10s ----+
|  state:  read only -- persist = false, so parallel tool        |
|          calls cannot race through the file                    |
|  read:   readLastModel() scans the transcript tail, but only   |
|          while the model is still "unknown"                    |
|  emit:   pi.tool_call.count, pi.tool_result.count,             |
|          pi.tool.duration     (from the payload's duration_ms) |
+----------------------------------------------------------------+
      |
      v
+-- Stop ----------------------------------------- sync, 10s ----+
|  read:   readTranscriptDelta(path, offset) -- saved offset to  |
|          EOF, summing usage over every assistant message       |
|  state:  write new offset + resolved model, clear turnStartTime|
|  emit:   pi.token.usage x4 types,                              |
|          pi.turn.duration, pi.turn.count                       |
+----------------------------------------------------------------+

===== end of turn ===============================================
      |
      v
+-- SessionEnd ----------------------------------- sync, 15s ----+
|  emit:   pi.session.duration                                   |
|  state:  delete the file                                       |
+----------------------------------------------------------------+

every emit above is a DELTA; the collector's deltatocumulative
processor stitches them back into one cumulative counter.
```

What each step actually does:

- **Spawn → stdin → dispatch.** The bridge reads one JSON payload, switches on
  `hook_event_name`, and stages metric closures. If nothing is staged it exits
  *without ever building a `MeterProvider`* — no connection, no flush timeout.
- **State is the only memory.** `SessionStart` writes the session start time;
  `UserPromptSubmit` writes the turn start time; `Stop` reads them back to
  compute durations. Lose the file and durations for that session stop being
  emitted — counters still work.
- **Token usage is pulled, not pushed.** The `Stop` payload has no usage object,
  so the bridge reads the transcript from its saved byte offset to EOF and sums
  every assistant message in that chunk. The offset is what keeps this O(one
  turn) and stops tokens being counted twice.
- **Flush is synchronous and then the process dies.** `forceFlush()` +
  `shutdown()` before exit, always exit 0.
- **Deltas are stitched downstream.** Each process reports only its own
  contribution; the collector's `deltatocumulative` turns the stream into the
  cumulative counters Prometheus expects.

## Files

| File | Role |
|------|------|
| `src/bridge.ts` | The whole process: stdin → event dispatch → staged metric emits → flush → exit. |
| `src/transcript.ts` | Incremental JSONL transcript reader. Where token usage comes from. |
| `src/version.ts` | `service.version`. Kept in sync with `package.json` by a test. |
| `.claude-plugin/plugin.json` | Plugin manifest; points at `hooks/hooks.json`. |
| `hooks/hooks.json` | Which hooks run the bridge, sync vs async, and timeouts. |
| `tsconfig.json` | Build config with the `rootDir: ".."` quirk described below. |

Config parsing is **not** here — `src/bridge.ts` imports `../../pi/src/config.ts`,
shared with the pi extension.

## Build layout

`npm run build:claude` runs esbuild, not tsc, and produces exactly one file:

```
claude/dist/bridge.cjs   <-- the hook entry point, ~456 KB, deps inlined
```

The shared `pi/src/config.ts` and every `@opentelemetry/*` package are bundled
in, so the installed plugin has no `node_modules` and no install step.
`tsconfig.json` is `--noEmit`; it exists only so `npm run typecheck` covers this
directory, and keeps `"rootDir": ".."` to reach the shared config.

Consequences worth remembering:

- **The bundle is committed to git.** A marketplace install copies `claude/`
  into the plugin cache and runs neither a build nor `npm install`, so the
  runnable file has to already be there. `.gitignore` un-ignores exactly
  `claude/dist/bridge.cjs`. Rebuild *and commit* it alongside any `claude/src/`
  change, or installed users keep running the previous version.
- **The output must be CommonJS with a `.cjs` extension.** An ESM bundle throws
  `Dynamic require of "perf_hooks" is not supported` at startup, because the
  OpenTelemetry SDK is CJS and uses dynamic requires. The explicit `.cjs`
  extension matters because only `claude/` is copied on install — the repo root
  `package.json` and its `"type": "module"` are not present to disambiguate a
  bare `.js`.
- `hooks/hooks.json` runs `${CLAUDE_PLUGIN_ROOT}/dist/bridge.cjs`, so
  `claude --plugin-dir` must point at **`claude/`**, not the repo root.
- `npm run build:claude` is required after any edit to `claude/src/` *or*
  `pi/src/config.ts`. Nothing rebuilds automatically; a stale `dist/` is the most
  common "my change did nothing" cause.

## Process lifecycle

`main()` in `src/bridge.ts`:

1. `getConfig()`; return silently unless `PI_OTLP_ENABLE=1`.
2. Read all of stdin, `JSON.parse` it. A parse failure returns quietly (logged
   only under `PI_OTLP_DEBUG=1`).
3. Pull `hook_event_name` and `session_id`; load this session's state file.
4. `switch` on the event name, pushing closures onto an `emits` array rather
   than emitting immediately.
5. Persist state if the handler asked for it.
6. **If `emits` is empty, return without ever constructing a `MeterProvider`.**
   That is the point of staging: an event with nothing to report never pays for
   an exporter, a connection attempt, or a flush timeout.
7. Otherwise build the provider, run the closures, then `forceFlush()` and
   `shutdown()` — both wrapped in `try`/`catch` so a dead collector cannot
   propagate.

The top-level `.catch()` swallows everything. **The bridge always exits 0**: a
non-zero hook exit surfaces as a visible failure in Claude Code, and telemetry
must never interrupt a session.

### Delta temporality

The exporter is configured with
`AggregationTemporalityPreference.DELTA`. A cumulative counter in a process that
lives for 200ms would restart at zero every hook and report `1` forever —
Prometheus would see a flat series and `rate()` / `increase()` would return
nothing. Delta lets each process report only its own contribution.

**This requires the `deltatocumulative` processor in the collector**
(opentelemetry-collector-contrib ≥ v0.104.0), or a backend that handles delta
sums natively. Without it, the plugin's data is unusable. The pi extension is
unaffected — it exports cumulative from one long-lived process.

### Debug exporter

`config.exporters` / `OTEL_METRICS_EXPORTER` is **deliberately ignored** here.
Claude Code strips `OTEL_*` from hook subprocesses, so honouring it would mean
falling back to the `console` default and silently never exporting OTLP. The
bridge always exports OTLP, and adds a console exporter when `PI_OTLP_DEBUG=1`.

## Hook → metric mapping

| Hook | Sync? | Timeout | Metrics emitted | State written |
|------|-------|---------|-----------------|---------------|
| `SessionStart` | sync | 10s | `pi.session.count` | ✅ start time, provider/model, `transcriptOffset = 0` |
| `UserPromptSubmit` | async | 10s | `pi.prompt.count` (`prompt.length`) | ✅ `turnStartTime` |
| `PostToolUse` | async | 10s | `pi.tool_call.count`, `pi.tool_result.count` (`success=true`), `pi.tool.duration` | ❌ |
| `PostToolUseFailure` | async | 10s | same, `success=false` | ❌ |
| `Stop` | sync | 10s | `pi.token.usage` (4 `type`s), `pi.turn.duration`, `pi.turn.count` | ✅ offset, model, clears `turnStartTime` |
| `SessionEnd` | sync | 15s | `pi.session.duration` | ❌ (deletes the file) |
| anything else | — | — | none | ❌ |

The sync/async split is load-bearing, and documented in `hooks.json`'s own
`description`: `SessionStart`, `Stop`, and `SessionEnd` can be immediately
followed by process exit, which would kill a backgrounded hook before it
flushes, so they must block. The rest run async to stay off the critical path.

Two consequences of the table:

- There is **no `PreToolUse` hook**. Both `pi.tool_call.count` and
  `pi.tool_result.count` are emitted at completion, so a tool that never
  finishes is never counted. Duration comes from the payload's `duration_ms`,
  guarded by `Number.isFinite` — if Claude Code stops sending that field, the
  duration panels quietly become pi-only (see
  [plan 05 §4](../docs/plans/05-minor-improvements.md)).
- `pi.turn.count` / `pi.turn.duration` are only emitted when a `turnStartTime`
  exists, i.e. a `UserPromptSubmit` preceded this `Stop`. Token usage is
  reported either way.

`pi.cost.usage` is **not** emitted at all — Claude Code hook events carry no cost
data. Use Claude Code's native `claude_code.cost.usage` for that.

## Session state

State lives in `~/.pi/otlp-claude/<session-id>.json` and holds
`sessionStartTime`, `provider`, `model`, `turnStartTime`, and
`transcriptOffset`.

- **One file per session.** A single shared file would be corrupted by
  concurrent sessions, and one session's `SessionEnd` would wipe another's. The
  session id is sanitized to `[A-Za-z0-9._-]` and truncated to 128 chars before
  use as a filename.
- **Atomic writes.** Write to `<file>.tmp.<pid>`, then `rename`. Every state
  operation is wrapped in `try`/`catch` and fails silently — telemetry never
  breaks the session.
- **`persist = false`** is how a handler opts out of writing. Tool events use it
  because they never need to mutate state, which removes any chance of parallel
  tool calls racing each other through the file. The side effect: a model id
  discovered by `readLastModel` during a tool event is *not* saved, so the next
  tool event rescans. That is the intended trade.
- **Pruning.** `SessionStart` deletes state files older than 7 days, cleaning up
  after sessions that never emitted `SessionEnd` (crash, kill).
- **`SessionEnd` deletes the file.**

There is a known race: `UserPromptSubmit` runs async and does a full
read-modify-write, so on a very fast turn its write can land after `Stop`'s and
regress `transcriptOffset`. See
[plan 05 §3](../docs/plans/05-minor-improvements.md).

## Where token usage comes from

Claude Code's `Stop` payload carries `last_assistant_message` as a plain
**string** — no usage object. So `src/transcript.ts` reads the session transcript
JSONL directly.

- `readTranscriptDelta(path, offset)` reads from the stored byte offset to EOF
  and sums `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and
  `cache_creation_input_tokens` across **every** `type: "assistant"` entry in the
  chunk — a single turn contains one assistant message per tool-calling round
  trip, so summing only the last would undercount.
- Only **whole lines** are consumed. The returned offset points just past the
  last newline, so a partially-flushed trailing line is re-read next time instead
  of being parsed torn and lost. Unparseable lines are skipped rather than
  aborting the turn.
- If the file is now **smaller** than the stored offset it was truncated or
  replaced, and the read restarts from 0.
- Reading incrementally keeps each `Stop` O(one turn) rather than O(whole
  session).

`readLastModel(path)` is a separate, bounded scan: it reads only the trailing
64KB and returns the most recent assistant `model` id, dropping the leading
partial line when the scan started mid-file.

### Model resolution

`SessionStart` reports no model in practice, so the id is filled in
progressively:

1. `SessionStart` — `event.model` as an object (`provider`/`id`), or as a plain
   string, else `ANTHROPIC_MODEL`, else `"unknown"`. Provider defaults to
   `anthropic`.
2. `PostToolUse` — only while the model is still unknown, `readLastModel` scans
   the transcript tail. Without this the first turn's tool metrics would all be
   labelled `model=unknown`.
3. `Stop` — the transcript delta's model id wins, since it is the resolved id
   the API actually used.

## Differences from the pi extension

| | pi extension | Claude bridge |
|---|---|---|
| Process | one, long-lived | one **per hook event** |
| `service.name` | `pi-coding-agent` | `pi-otlp-claude` |
| Temporality | cumulative | **delta** (needs `deltatocumulative`) |
| Token source | `usage` on the assistant message | parsed from the transcript JSONL |
| `pi.cost.usage` | emitted | **not available** |
| State | in-memory closure | `~/.pi/otlp-claude/*.json` |
| Honours `OTEL_METRICS_EXPORTER` | yes | no (always OTLP) |
| Build | none, loaded from source | esbuild bundle, committed to git |
| Install | `pi install git:github.com/rulasfia/agents-telemetry` | `/plugin install pi-otlp@agents-telemetry` |

Metric names and attributes are otherwise identical, so both sources land in the
same dashboard panels and are told apart by the `service_name` label.

## Known issues

Read [`docs/plans/`](../docs/plans/) before changing bridge behavior. The two
that bite hardest:

- [Resume/compact token double-count](../docs/plans/02-resume-token-double-count.md)
  — `SessionStart` unconditionally resets `transcriptOffset` to 0, so
  `claude --resume` and post-compaction restarts re-sum the entire prior
  transcript.
- [Sync hook stall on unreachable collector](../docs/plans/04-sync-hook-exporter-timeout.md)
  — the exporter's default ~10s timeout is not capped below the hook timeout, so
  an unreachable collector can stall every session start and turn end.

## Debugging

Run one event by hand, no Claude Code involved:

```bash
npm run build:claude
PI_OTLP_ENABLE=1 PI_OTLP_DEBUG=1 PI_OTLP_ENDPOINT=http://localhost:4418 \
  node claude/dist/bridge.cjs <<'EOF'
{"hook_event_name":"SessionStart","session_id":"test","model":{"provider":"anthropic","id":"claude-sonnet-5"}}
EOF
```

For a full session, use the replay harness — it spawns one process per hook
exactly as Claude Code does, which is the only way process-boundary bugs (state
persistence, delta stitching, flush-before-exit) actually show up:

```bash
npm run dev:up                 # collector on 4418, not the production 4318
npm run dev:replay             # build + 9 hook events; prints expected totals
npm run dev:metrics            # cumulative totals to compare against
npm run dev:metrics -- --raw   # per-export payloads, delta temporality visible
```

`scripts/dev-replay.mjs` points `HOME` at a scratch directory so replay state
never mixes with real sessions in `~/.pi/otlp-claude/`. Note that
`npx vitest run claude/src/transcript.test.ts` covers the transcript parser only
— nothing unit-tests the bridge's process lifecycle, so replay is the real check.
