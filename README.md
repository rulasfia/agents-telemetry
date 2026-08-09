# agents-telemetry

OpenTelemetry metrics for [pi-coding-agent](https://github.com/badlogic/pi-mono), [Claude Code](https://claude.com/claude-code), and [OpenCode V2](https://opencode.ai/v2). Track sessions, turns, tool usage, token consumption, costs, and performance timing.

<img width="1055" height="856" alt="Screenshot 2026-02-12 at 4 14 58 PM" src="https://github.com/user-attachments/assets/a6a377de-f659-4b8c-8f40-8c9038eb92a6" />

All emitters use the **same `pi.*` metric names**, so one dashboard covers them all. They are told apart by `service_name`: `pi-coding-agent`, `pi-otlp-claude`, and `pi-otlp-opencode`.

## Installation

Set up telemetry in order: install one or more harness integrations, start the
self-hosted stack, then open Grafana. The three integrations are independent;
install only the ones you use.

### 1. Install A Harness Integration

#### pi-coding-agent

```bash
pi install git:github.com/rulasfia/agents-telemetry
```

The extension is loaded directly from source, so there is nothing to compile.

To hack on it, install from a local clone instead — source changes take effect after `/reload`:

```bash
pi install /absolute/path/to/agents-telemetry
```

See [`pi/README.md`](./pi/README.md) for how the extension works internally.

#### Claude Code

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

> The included self-hosted stack handles Claude Code's delta temporality. If you
> use another collector, apply the [Delta temporality](#delta-temporality)
> configuration to it.

See [`claude/README.md`](./claude/README.md) for how the hook bridge works internally.

#### OpenCode V2

Add the package to the V2 `plugins` array in `opencode.json` or
`.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@rulasfia/agents-telemetry"]
}
```

For a local checkout, point the plugin entry at the repository root:

```json
{
  "plugins": ["./opencode/src/index.ts"]
}
```

The OpenCode V2 plugin API is beta. This package targets its `/v2` plugin API;
verify that it loaded with `opencode2 api get /api/plugin`.

### 2. Start The Self-Hosted Stack

The included Docker Compose stack runs an OpenTelemetry Collector, Prometheus,
and Grafana. It already converts Claude Code's delta metrics to cumulative
metrics for Prometheus and provisions this dashboard.

```bash
git clone https://github.com/rulasfia/agents-telemetry.git
cd agents-telemetry/stack
cp .env.example .env
# Edit .env: set a long Grafana password and, when needed, the LAN/VPN bind address.
docker compose -f docker-compose.homeserver.yml up -d
```

Point each installed harness at the machine running the stack, then enable the
ones you installed. Use `localhost` only when the harness and stack share a
machine; otherwise use its LAN or VPN address.

```bash
export ATEL_ENDPOINT=http://telemetry-host:4318
export ATEL_PI=1              # pi-coding-agent
export ATEL_CLAUDE_CODE=1     # Claude Code
export ATEL_OPENCODE=1        # OpenCode V2
```

The collector's OTLP endpoint must be reachable only from trusted LAN or VPN
clients. Do not expose port `4318` to the public internet.

### 3. Open The Dashboard

Open `http://localhost:3000` on the stack host and sign in with
`GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` from `stack/.env`. The
provisioned **Pi Coding Agent - OTLP Metrics** dashboard shows every enabled
harness, with `service_name` separating their data.

If Grafana is on a remote host, use its VPN or reverse-proxy URL, or tunnel it:

```bash
ssh -L 3000:localhost:3000 telemetry-host
```

Then open `http://localhost:3000` locally. See [Configuration](#configuration)
for exporters, headers, and other options.

## Configuration

Everything is configured through one `ATEL_*` namespace, shared by all harnesses.
Only enablement is per-agent, so you can run telemetry for one without the other.

```bash
# Enablement — set the one(s) you want. Nothing is emitted otherwise.
export ATEL_PI=1
export ATEL_CLAUDE_CODE=1
export ATEL_OPENCODE=1

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
| `ATEL_OPENCODE` | off | `1` enables the OpenCode V2 plugin |
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

### Upgrading from 0.3.x

**0.4.0 renames every environment variable.** Nothing is emitted until you
migrate, and the failure is silent — no error, no warning, just a flat
dashboard. If your metrics stopped after updating, this is why.

| 0.3.x | 0.4.0 |
|---|---|
| `PI_OTLP_ENABLE=1` | `ATEL_PI=1` and/or `ATEL_CLAUDE_CODE=1` — one per agent, neither implies the other |
| `PI_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` | `ATEL_ENDPOINT` |
| `PI_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `ATEL_METRICS_ENDPOINT` |
| `OTEL_METRICS_EXPORTER` | `ATEL_EXPORTERS` — now defaults to `otlp`, was `console` |
| `PI_OTLP_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_INTERVAL` | `ATEL_EXPORT_INTERVAL` |
| `PI_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_HEADERS` | `ATEL_HEADERS` |
| `PI_OTLP_METRICS_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | `ATEL_METRICS_HEADERS` |
| `PI_OTLP_DEVICE_NAME` | `ATEL_DEVICE_NAME` |
| `PI_OTLP_DEBUG` | `ATEL_DEBUG` |

Check for leftovers, then confirm metrics flow again with `ATEL_DEBUG=1`:

```bash
env | grep -E '^(PI_OTLP|OTEL)_'   # should be empty, or set ATEL_* alongside
```

Two changes also affect existing dashboards and stored data:

- **`prompt.length` is now `prompt.length.bucket`** (`0-100`, `100-1k`,
  `1k-10k`, `10k+`). The raw character count made every distinct prompt length
  its own Prometheus series. Any panel or query referencing `prompt_length`
  returns nothing after upgrading; the shipped dashboard never used it.
- **Token totals drop, and that is the fix.** 0.3.x re-counted the whole
  transcript after compaction or resume, inflating `pi.token.usage` — measured
  at 2.25× over one compact-and-resume session. Historical data stays inflated;
  it cannot be backfilled. Since `service_version` is a metric label, you can
  separate the two eras: `pi_token_usage_tokens_total{service_version="0.4.0"}`
  is trustworthy, `0.3.x` is not.

### Delta temporality

Claude Code runs each hook in its own short-lived process, so the plugin has no
long-running meter to accumulate into. It exports **delta** metrics and relies
on the collector to convert them, because a cumulative counter would restart at
zero on every hook and Prometheus would see a permanently flat series.

Add the `deltatocumulative` processor to your collector's metrics pipeline
(already configured in [`stack/otel-collector.yaml`](./stack/otel-collector.yaml)):

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

> **Claude Code and OpenCode note:** Both plugins emit the same metric names so dashboards work unchanged, with one exception. Cost (`pi.cost.usage`) is not available as a per-token-type breakdown from their event payloads. OpenCode does expose a total per-step cost, but it cannot be truthfully labelled as `input`, `output`, `cache_read`, or `cache_write`, so this plugin does not emit it. Claude Code users can use its native `claude_code.cost.usage` metric. Token usage is reported by both.

### Counters

All counters include base attributes: `session.id`, `provider`, `model`.
Tool metrics normalize `tool.name` to lowercase snake case with a two-letter
harness prefix: `pi_read`, `cc_read`, or `oc_read`. This avoids ambiguous pairs
such as pi's `read` and Claude Code's `Read`; custom and MCP tool names follow
the same rule. Existing stored series keep their old labels, so queries spanning
an upgrade may show both forms until the backend's retention window expires.

> `session.id` is high-cardinality. Drop it in the collector before Prometheus for long-lived aggregate metrics.

| Metric | Description | Additional Attributes |
|--------|-------------|----------------------|
| `pi.session.count` | Sessions started | — |
| `pi.turn.count` | Agent turns (tool-calling loops) | — |
| `pi.tool_call.count` | Tool invocations | normalized `tool.name` (`pi_*`/`cc_*`/`oc_*`) |
| `pi.tool_result.count` | Tool completions | normalized `tool.name`, `success` |
| `pi.prompt.count` | User prompts | `prompt.length.bucket` (`0-100`/`100-1k`/`1k-10k`/`10k+`) |
| `pi.token.usage` | Token consumption | `type` (input/output/cache_read/cache_write) |
| `pi.cost.usage` | Cost in USD | `type` (input/output/cache_read/cache_write) |

### Histograms

All histograms include base attributes: `session.id`, `provider`, `model`.

| Metric | Description | Unit | Additional Attributes |
|--------|-------------|------|----------------------|
| `pi.session.duration` | Session duration | seconds | — |
| `pi.turn.duration` | Turn duration | seconds | — |
| `pi.tool.duration` | Tool execution duration | seconds | normalized `tool.name`, `success` |

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
