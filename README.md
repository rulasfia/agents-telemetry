# pi-otlp

OpenTelemetry metrics extension for [pi-coding-agent](https://github.com/badlogic/pi-mono). Track sessions, turns, tool usage, token consumption, costs, and performance timing.

<img width="1055" height="856" alt="Screenshot 2026-02-12 at 4 14 58 PM" src="https://github.com/user-attachments/assets/a6a377de-f659-4b8c-8f40-8c9038eb92a6" />

## Installation

```bash
pi install C:\\Users\\rulasfia\\.pi\\pi-otlp
```

This local package is loaded directly from disk, so source changes take effect after `/reload`.

## Configuration

Enable via environment variables:

```bash
# Required: enable the extension
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

# Optional: OTLP headers for authentication. Signal-specific headers override these.
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer token"
export OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer metrics-token"

# Optional: debug logging
export PI_OTLP_DEBUG=1
```

## Metrics

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

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus]
```

### Local Development with Docker

```bash
docker run -d --name otel-collector \
  -p 4318:4318 \
  otel/opentelemetry-collector-contrib:latest
```

### Full Stack Demo

See [`demo/`](./demo) for a complete Docker Compose setup with OTLP Collector, Prometheus, and pre-configured Grafana dashboards.

## License

MIT
