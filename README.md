# agents-telemetry

OpenTelemetry metrics extension for [pi-coding-agent](https://github.com/badlogic/pi-mono). Track sessions, turns, tool usage, token consumption, costs, and performance timing.

<img width="1055" height="856" alt="Screenshot 2026-02-12 at 4 14 58 PM" src="https://github.com/user-attachments/assets/a6a377de-f659-4b8c-8f40-8c9038eb92a6" />

## Installation

### pi-coding-agent

Install from a local clone:

```bash
pi install /absolute/path/to/agents-telemetry
```

The local package is loaded directly from disk, so source changes take effect after `/reload`.

### Claude Code

Build the plugin first:

```bash
cd /absolute/path/to/agents-telemetry
npm run build:claude
```

Then load it with `--plugin-dir`:

```bash
claude --plugin-dir "$(pwd)/claude"
```

To avoid passing the flag every time, add it to your shell profile as an alias:

```bash
alias claude='claude --plugin-dir "/absolute/path/to/agents-telemetry/claude"'
```

> **Note:** `claude plugin install` is only for marketplace plugins, and `~/.claude/skills/` is for `SKILL.md` skills — neither loads a local plugin's hooks. Use `--plugin-dir`.

> The plugin emits the **same `pi.*` metric names** as the pi extension, so your existing Grafana dashboards work unchanged. It does require one collector-side change — see [Delta temporality](#delta-temporality).

## Configuration

Enable via environment variables:

```bash
# Required: enable the extension / plugin
export PI_OTLP_ENABLE=1

# Choose exporters (console, otlp, or both)
export OTEL_METRICS_EXPORTER=console

# For OTLP export (e.g., to Grafana, Datadog, or any OTLP-compatible backend)
export OTEL_METRICS_EXPORTER=otlp

# Base endpoint: the extension appends /v1/metrics.
export OTEL_EXPORTER_OTLP_ENDPOINT=http://homeserver:4318

# Or use a complete metrics endpoint verbatim (takes precedence over the base endpoint).
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://homeserver:4318/v1/metrics

# Optional: export interval (default: 60000ms)
export OTEL_METRIC_EXPORT_INTERVAL=10000

# Optional: stable, friendly device label for multi-device dashboards.
export PI_OTLP_DEVICE_NAME=desktop

# Optional: OTLP headers for authentication. Signal-specific headers override these.
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer token"
export OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer metrics-token"

# Optional: debug logging
export PI_OTLP_DEBUG=1
```

### Claude Code compatibility

Claude Code strips `OTEL_*` environment variables from hook subprocesses. To keep one shared config, the plugin also reads `PI_OTLP_*` fallbacks:

```bash
export PI_OTLP_ENABLE=1

# Base endpoint — /v1/metrics is appended, mirroring OTEL_EXPORTER_OTLP_ENDPOINT.
export PI_OTLP_ENDPOINT=http://homeserver:4318

# Or a complete metrics endpoint used verbatim, mirroring
# OTEL_EXPORTER_OTLP_METRICS_ENDPOINT (takes precedence over the base form).
export PI_OTLP_METRICS_ENDPOINT=http://homeserver:4318/v1/metrics

export PI_OTLP_HEADERS="Authorization=Bearer token"
export PI_OTLP_METRICS_HEADERS="Authorization=Bearer metrics-token"
export PI_OTLP_EXPORT_INTERVAL=10000
```

These work for both pi and Claude Code without duplication. Each `PI_OTLP_*`
variable is the fallback for exactly one `OTEL_*` variable; the `OTEL_*` form
wins when both are set.

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
