# Shared-config exporter gap for pi

**Severity:** Medium — a documented configuration silently disables OTLP export for
one of the two sources.
**Files:** `src/config.ts`, `README.md`, tests

## Problem

The README's "Claude Code compatibility" section says a `PI_OTLP_*`-only environment
"works for both pi and Claude Code without duplication":

```bash
export PI_OTLP_ENABLE=1
export PI_OTLP_ENDPOINT=http://homeserver:4318
```

That's true for the Claude bridge — it deliberately ignores `OTEL_METRICS_EXPORTER`
and always exports OTLP. But the **pi extension honors it**, and its default is
`"console"` (`src/config.ts:15`):

```ts
const exporterStr = process.env.OTEL_METRICS_EXPORTER ?? "console";
```

So with a PI-only environment, pi:

1. never sends OTLP — no pi data on the dashboard, and
2. attaches a `ConsoleMetricExporter` that writes to stdout underneath the TUI.

There is a `PI_OTLP_*` fallback for every `OTEL_*` variable *except* the exporter
selector, which is exactly the variable the shared-config story needs.

## Fix

Preferred (smallest surprise): **default exporters to `otlp` when a PI_OTLP endpoint
is configured** and no explicit `OTEL_METRICS_EXPORTER` is set:

```ts
const exporterStr =
  process.env.OTEL_METRICS_EXPORTER ??
  (process.env.PI_OTLP_ENDPOINT || process.env.PI_OTLP_METRICS_ENDPOINT
    ? "otlp"
    : "console");
```

Alternative: add a `PI_OTLP_EXPORTER` fallback variable, keeping the strict
one-fallback-per-OTEL-variable pattern the config comment establishes. This is more
explicit but adds a variable users must know about; the inference above makes the
README's existing example just work. Either way:

- Update the README compatibility section to state the resolved behavior.
- Add config tests: PI-endpoint-only env → `exporters: ["otlp"]`; explicit
  `OTEL_METRICS_EXPORTER=console` still wins.

## Acceptance

- A shell exporting only `PI_OTLP_ENABLE=1` and `PI_OTLP_ENDPOINT=...` produces OTLP
  export from **both** pi and Claude Code, with no console noise in the pi TUI.
