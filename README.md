# agents-telemetry

OpenTelemetry metrics for [pi-coding-agent](https://github.com/badlogic/pi-mono) **and** [Claude Code](https://claude.com/claude-code). Track sessions, turns, tool usage, token consumption, costs, and performance timing.

<img width="1055" height="856" alt="Screenshot 2026-02-12 at 4 14 58 PM" src="https://github.com/user-attachments/assets/a6a377de-f659-4b8c-8f40-8c9038eb92a6" />

Both agents emit the **same `pi.*` metric names**, so one dashboard covers both. They are told apart by `service_name`: `pi-coding-agent` vs `pi-otlp-claude`.

## Installation

Each agent installs with a single command — no clone, no build step.

### pi-coding-agent

```bash
pi install git:github.com/rulasfia/agents-telemetry
```

The extension is loaded directly from source, so there is nothing to compile.

To hack on it, install from a local clone instead — source changes take effect after `/reload`:

```bash
pi install /absolute/path/to/agents-telemetry
```

See [`pi/README.md`](./pi/README.md) for how the extension works internally.

### Claude Code

Add the marketplace, then install the plugin:

```
/plugin marketplace add rulasfia/agents-telemetry
/plugin install pi-otlp@agents-telemetry
```

The plugin ships as a single pre-bundled file with no runtime dependencies, so nothing is compiled or `npm install`ed on your machine. Pick up later releases with `/plugin marketplace update agents-telemetry`.

To hack on it, build from a local clone and load that with `--plugin-dir`:

```bash
npm ci && npm run build:claude
claude --plugin-dir "$(pwd)/claude"
```

> **Note:** `--plugin-dir` must point at the `claude/` directory, not the repo root. `~/.claude/skills/` is for `SKILL.md` skills and does not load a plugin's hooks.

> Your existing Grafana dashboards work unchanged, but the Claude Code plugin needs one collector-side change the pi extension does not — see [Delta temporality](#delta-temporality).

See [`claude/README.md`](./claude/README.md) for how the hook bridge works internally.

### Next step

Neither emitter does anything until you enable it. At minimum:

```bash
export ATEL_PI=1              # turn on the pi extension
export ATEL_CLAUDE_CODE=1     # turn on the Claude Code plugin
export ATEL_ENDPOINT=http://localhost:4318
```

See [Configuration](#configuration) for the full set.

## Configuration

Everything is configured through one `ATEL_*` namespace, shared by both agents.
Only enablement is per-agent, so you can run telemetry for one without the other.

```bash
# Enablement — set the one(s) you want. Nothing is emitted otherwise.
export ATEL_PI=1
export ATEL_CLAUDE_CODE=1

# Base endpoint: /v1/metrics is appended.
export ATEL_ENDPOINT=http://homeserver:4318

# Or a complete metrics endpoint, used verbatim (takes precedence over the base form).
export ATEL_METRICS_ENDPOINT=http://homeserver:4318/v1/metrics

# Optional: exporters — otlp, console, or both. Default: otlp.
export ATEL_EXPORTERS=otlp,console

# Optional: export interval in ms. Default: 60000.
export ATEL_EXPORT_INTERVAL=10000

# Optional: headers for authentication. Metrics-specific headers override the general ones.
export ATEL_HEADERS="Authorization=Bearer token"
export ATEL_METRICS_HEADERS="Authorization=Bearer metrics-token"

# Optional: stable, friendly device label for multi-device dashboards.
export ATEL_DEVICE_NAME=desktop

# Optional: debug logging.
export ATEL_DEBUG=1
```

| Variable | Default | Notes |
|---|---|---|
| `ATEL_PI` | off | `1` enables the pi extension |
| `ATEL_CLAUDE_CODE` | off | `1` enables the Claude Code plugin |
| `ATEL_ENDPOINT` | `http://localhost:4318` | base URL; `/v1/metrics` is appended |
| `ATEL_METRICS_ENDPOINT` | — | used verbatim; wins over `ATEL_ENDPOINT` |
| `ATEL_EXPORTERS` | `otlp` | comma-separated: `otlp`, `console` |
| `ATEL_EXPORT_INTERVAL` | `60000` | milliseconds |
| `ATEL_HEADERS` | — | `Key=value,Key2=value2` |
| `ATEL_METRICS_HEADERS` | — | merged over `ATEL_HEADERS` |
| `ATEL_DEVICE_NAME` | — | adds a `device.name` resource attribute |
| `ATEL_DEBUG` | off | verbose diagnostics; also adds the console exporter |

> **`OTEL_*` and `PI_OTLP_*` are not read.** Claude Code strips `OTEL_*` from hook
> subprocesses, so honouring it would configure one agent and silently skip the
> other — the reason the old `PI_OTLP_*` fallbacks existed. `ATEL_*` survives that,
> so one name per setting is enough. If you already export a machine-wide
> `OTEL_EXPORTER_OTLP_ENDPOINT`, set `ATEL_ENDPOINT` alongside it.

### Delta temporality

Claude Code runs each hook in its own short-lived process, so the plugin has no
long-running meter to accumulate into. It exports **delta** metrics and relies
on the collector to convert them, because a cumulative counter would restart at
zero on every hook and Prometheus would see a permanently flat series.

Add the `deltatocumulative` processor to your collector's metrics pipeline
(already configured in [`deploy/`](./deploy) and [`demo/`](./demo)):

```yaml
processors:
  deltatocumulative:

service:
  pipelines:
    metrics:
      processors: [deltatocumulative, batch]
```

It requires opentelemetry-collector-contrib **v0.104.0 or newer**. Backends that
ingest OTLP directly and handle delta sums natively (Grafana Cloud, Datadog,
and similar) need no extra configuration. The pi extension is unaffected — it
exports cumulative from a single long-lived process.

## Metrics

> **Claude Code note:** The plugin emits the same metric names so dashboards work unchanged, with one exception. Cost (`pi.cost.usage`) is not available from Claude Code hook events — use Claude Code's native `claude_code.cost.usage` metric if you need cost tracking there. Token usage *is* reported: the `Stop` hook carries no usage payload, so the plugin reads it incrementally from the session transcript, summing every assistant message in the turn.

### Counters

All counters include base attributes: `session.id`, `provider`, `model`.

> `session.id` is high-cardinality. Drop it in the collector before Prometheus for long-lived aggregate metrics.

| Metric | Description | Additional Attributes |
|--------|-------------|----------------------|
| `pi.session.count` | Sessions started | — |
| `pi.turn.count` | Agent turns (tool-calling loops) | — |
| `pi.tool_call.count` | Tool invocations | `tool.name` |
| `pi.tool_result.count` | Tool completions | `tool.name`, `success` |
| `pi.prompt.count` | User prompts | `prompt.length` |
| `pi.token.usage` | Token consumption | `type` (input/output/cache_read/cache_write) |
| `pi.cost.usage` | Cost in USD | `type` (input/output/cache_read/cache_write) |

### Histograms

All histograms include base attributes: `session.id`, `provider`, `model`.

| Metric | Description | Unit | Additional Attributes |
|--------|-------------|------|----------------------|
| `pi.session.duration` | Session duration | seconds | — |
| `pi.turn.duration` | Turn duration | seconds | — |
| `pi.tool.duration` | Tool execution duration | seconds | `tool.name`, `success` |

## Commands

- `/otlp-status` — Show telemetry status (sessions, turns, tools, tokens, costs, durations)

## Example Output

```
OTLP Telemetry Status:
  Sessions: 1
  Turns: 5
  Tool calls: 23
  Prompts: 3
  Tokens: 45231 (in: 38000, out: 6000, cache: 1200/31)
  Cost: $0.0234 (in: $0.0190, out: $0.0044)
  Durations:
    Session: 5.2s last, 4.1s avg
    Turn: 1.2s last, 0.8s avg
    Tool: 91ms last, 64ms avg
  Exporters: otlp
  Endpoint: http://localhost:4318/v1/metrics
```

## OTLP Backend Setup

### Grafana Alloy / OpenTelemetry Collector

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  # Required by the Claude Code plugin; harmless for the pi extension.
  # See "Delta temporality" above.
  deltatocumulative:

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [deltatocumulative]
      exporters: [prometheus]
```

### Local Development with Docker

```bash
docker run -d --name otel-collector \
  -p 4318:4318 \
  otel/opentelemetry-collector-contrib:latest
```

### Full Stack Demo

See [`stack/`](./stack) for a complete Docker Compose setup with OTLP Collector, Prometheus, and pre-configured Grafana dashboards.

## License

MIT
