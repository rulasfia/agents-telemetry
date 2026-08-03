# AGENTS.md

Compact guide for working in this repo.

## What this repo is

A dual-source OpenTelemetry metrics package:

- `pi/src/` — pi-coding-agent extension (long-lived TypeScript module). Architecture: [`pi/README.md`](pi/README.md).
- `claude/src/` — Claude Code plugin bridge (short-lived Node process invoked per hook event). Architecture: [`claude/README.md`](claude/README.md).
- `stack/` — Docker Compose demo stack: OTel Collector → Prometheus → Grafana.
- `docs/plans/` — active known issues from the 2026-08-03 review; read before fixing dashboard/metrics behavior.

Both emitters share `pi/src/config.ts` and emit the same `pi.*` metric names, but use different `service.name` values: `pi-coding-agent` (pi) vs `pi-otlp-claude` (Claude Code).

## Developer commands

```bash
npm ci
npm run typecheck       # both projects: typecheck:pi then typecheck:claude
npm test                # all 71 tests via vitest defaults
npm run test:watch      # vitest watch mode
npm run build:claude    # bundle the Claude plugin to claude/dist/bridge.cjs
```

Neither tsconfig emits — `typecheck:pi` and `typecheck:claude` are both `--noEmit`. The
only build output in the repo is the esbuild bundle.

Run a single test file:

```bash
npx vitest run pi/src/config.test.ts
npx vitest run claude/src/transcript.test.ts
```

Suggested verification order: `npm run typecheck` → `npm test` → `npm run build:claude`.

## Seeing real metrics locally

The unit tests mock the OTLP SDK, so they never prove a metric reaches a backend. For that, use the dev stack — a second collector on offset ports that can run alongside a production collector on 4318.

```bash
npm run dev:up          # collector on 4418 (OTLP/HTTP), 8890 (Prometheus)
npm run dev:replay      # build + drive the Claude bridge through 9 hook events
npm run dev:pi          # drive the pi extension through a 3-turn session
npm run dev:metrics     # compact cumulative totals
npm run dev:metrics -- --raw   # per-export payloads, delta temporality visible
npm run dev:logs        # collector debug output, one line per data point
npm run dev:reset       # wipe collected data, keep the stack up
npm run dev:down
```

Both harnesses print the totals they expect, so a mismatch against `dev:metrics` is the bug.

- `scripts/dev-replay.mjs` spawns one process per hook event, exactly as Claude Code does — that is the only way process-boundary bugs (state persistence, delta temporality, flush-before-exit) show up. It points `HOME` at a scratch dir so replay state never mixes with real sessions in `~/.pi/otlp-claude/`.
- `scripts/dev-pi-session.ts` runs the pi extension in one long-lived process with cumulative temporality. It uses the event names `pi/src/index.ts` actually subscribes to; the older `pi/test/verify/integration-demo.ts` still emits `tool_call`/`tool_result`, which nothing listens for, so its tool metrics are silently no-ops.
- `stack/otel-collector-dev.yaml` runs two pipelines off the same receiver: `metrics/raw` (no processors, written to `stack/dev-out/raw.jsonl`) and `metrics/cumulative` (after `deltatocumulative`, written to `cumulative.jsonl` and exposed to Prometheus). Comparing the two files is the fastest way to debug delta-stitching.
- Dashboard work: `docker compose -f stack/docker-compose.dev.yml --profile dashboard up -d` adds Prometheus on 9091 and Grafana on 3001 (anonymous admin, no login).
- Both emitters produce identical `pi.*` metric names; `service_name` is what separates `pi-coding-agent` from `pi-otlp-claude`.

## Build quirks

- The pi extension is loaded directly from source by `pi-coding-agent`; it has no build step. Its entry point is declared in `package.json` under `"pi".extensions` → `pi/src/index.ts`.
- `npm run build:claude` must be run after any change to `claude/src/`, `pi/src/config.ts`, or `claude/src/version.ts` before the Claude plugin sees it.
- The build is esbuild, not tsc: everything bundles into the single file `claude/dist/bridge.cjs`, dependencies inlined. `claude/tsconfig.json` is `--noEmit` and exists only to typecheck (it keeps `"rootDir": ".."` so it can share `pi/src/config.ts`).
- **`claude/dist/bridge.cjs` is committed**, against the usual rule. A marketplace install copies `claude/` into the plugin cache and runs no build and no `npm install`, so the runnable artifact has to be in the repo. `.gitignore` un-ignores exactly that one path. Rebuild and commit it with any `claude/src/` change, or installed users keep running the old code.
- Two bundling constraints, both learned the hard way — don't "modernize" them:
  - **Format must be `cjs`.** An ESM bundle dies at startup with `Dynamic require of "perf_hooks" is not supported`, because the OpenTelemetry SDK is CJS and does dynamic requires.
  - **Extension must be `.cjs`.** Only `claude/` is copied on install, so the repo root `package.json` (`"type": "module"`) is absent and a bare `.js` would be resolved by whatever ambient package.json Node finds.
- `claude/hooks/hooks.json` runs `${CLAUDE_PLUGIN_ROOT}/dist/bridge.cjs`, so `claude --plugin-dir` must point at the `claude/` directory, not the repo root.
- `.claude-plugin/marketplace.json` at the repo root is the Claude Code marketplace catalog; it lists the plugin with `"source": "./claude"` (relative sources resolve against the marketplace root, the directory holding `.claude-plugin/`). Validate both manifests with `claude plugin validate .` and `claude plugin validate ./claude`.
- The plugin is version-pinned by `version` in `claude/.claude-plugin/plugin.json`. Users only receive an update when that string changes, so bump it (alongside `package.json` and `claude/src/version.ts`) when releasing.

## Installing

End users install each side with one command (see `README.md`):

```bash
pi install git:github.com/rulasfia/agents-telemetry   # pi extension
```

```
/plugin marketplace add rulasfia/agents-telemetry     # Claude Code
/plugin install pi-otlp@agents-telemetry
```

### Loading from a local checkout

```bash
pi install /absolute/path/to/agents-telemetry
```

Source changes take effect after the pi `/reload` command.

```bash
npm run build:claude
claude --plugin-dir "$(pwd)/claude"
```

`~/.claude/skills/` does not load a plugin's hooks — use `--plugin-dir` for local work.

## Configuration gotchas

- `PI_OTLP_ENABLE=1` is required to enable either emitter.
- Standard `OTEL_*` env vars are supported, with `PI_OTLP_*` fallbacks so Claude Code (which strips `OTEL_*` from hook subprocesses) can share config.
- **Important exporter gap:** `OTEL_METRICS_EXPORTER` defaults to `console` in `pi/src/config.ts`. A `PI_OTLP_*`-only env will export OTLP from the Claude bridge but **not** from the pi extension. Set `OTEL_METRICS_EXPORTER=otlp` explicitly when you want pi OTLP export.
- Base endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` / `PI_OTLP_ENDPOINT`) has `/v1/metrics` appended. The signal-specific endpoint vars (`..._METRICS_ENDPOINT`) are used verbatim and take precedence.

## Claude bridge behavior

- Each hook event spawns a fresh `node claude/dist/bridge.cjs` process that reads the event JSON from stdin.
- Because each process is short-lived, the bridge exports **delta** temporality. The collector must run the `deltatocumulative` processor to turn deltas into cumulative counters for Prometheus.
- The bridge persists per-session state in `~/.pi/otlp-claude/` so it can resume across hooks.
- The bridge does **not** emit `pi.cost.usage` — Claude Code hook events do not expose cost data.
- Debug mode (`PI_OTLP_DEBUG=1`) also enables a console exporter in addition to OTLP.

## Local backend stack

Use the files in `stack/` for a self-contained demo:

```bash
cd stack
cp .env.example .env          # edit passwords/version pins
docker compose -f docker-compose.homeserver.yml up -d
```

Notes:

- The collector image must be `opentelemetry-collector-contrib` ≥ v0.104.0 for the `deltatocumulative` processor.
- The simple `stack/docker-compose.yml` is currently broken: it mounts `./otel-collector-config.yaml`, but that file does not exist (`otel-collector.yaml` does). Prefer `docker-compose.homeserver.yml` or fix the volume mapping.
- README references to `deploy/` and `demo/` directories are stale; the real stack is `stack/`.

## Testing notes

- No `vitest.config.ts` exists; vitest uses defaults and discovers `*.test.ts` files.
- Config tests strip `PI_OTLP_*` and `OTEL_*` env vars in `beforeEach` to avoid leaking your local environment into assertions.
- Transcript tests write temp files under `os.tmpdir()` and clean them up.

## Debugging the bridge in isolation

```bash
npm run build:claude
PI_OTLP_ENABLE=1 PI_OTLP_DEBUG=1 PI_OTLP_ENDPOINT=http://localhost:4318 \
  node claude/dist/bridge.cjs <<'EOF'
{"hook_event_name":"SessionStart","session_id":"test","model":{"provider":"anthropic","id":"claude-sonnet-5"}}
EOF
```
