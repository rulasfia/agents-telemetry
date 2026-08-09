/**
 * Shared configuration for both emitters.
 *
 * Every setting is read from a single `ATEL_*` namespace so one exported
 * environment configures pi and Claude Code identically. Only enablement is
 * per-emitter, so you can run telemetry for one agent without the other.
 *
 * `OTEL_*` and the older `PI_OTLP_*` names are deliberately not consulted.
 * `PI_OTLP_*` only ever existed because Claude Code strips `OTEL_*` from hook
 * subprocesses; `ATEL_*` survives that, so one name per setting is enough.
 */

/** Which emitter is asking — selects the enable variable. */
export type TelemetrySource = "pi" | "claude-code" | "opencode";

/** The enable flag is per-emitter; everything else is shared. */
const ENABLE_VAR: Record<TelemetrySource, string> = {
  pi: "ATEL_PI",
  "claude-code": "ATEL_CLAUDE_CODE",
  opencode: "ATEL_OPENCODE",
};

export interface OtlpConfig {
  enabled: boolean;
  debug: boolean;
  exporters: ("console" | "otlp")[];
  otlpEndpoint: string;
  otlpHeaders: Record<string, string>;
  exportIntervalMs: number;
  deviceName?: string;
}

export function getConfig(source: TelemetrySource): OtlpConfig {
  const enabled = process.env[ENABLE_VAR[source]] === "1";
  const debug = process.env.ATEL_DEBUG === "1";

  // Defaults to otlp: exporting to a collector is the point, and a console
  // default would make the two emitters diverge under identical config.
  const exporterStr = process.env.ATEL_EXPORTERS ?? "otlp";
  const exporters = exporterStr
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean) as ("console" | "otlp")[];

  // ATEL_ENDPOINT is a base URL that gets /v1/metrics appended;
  // ATEL_METRICS_ENDPOINT is the signal-specific form, used verbatim, and wins.
  const metricsEndpoint = process.env.ATEL_METRICS_ENDPOINT;
  const endpoint = process.env.ATEL_ENDPOINT;
  const otlpEndpoint = metricsEndpoint
    ? metricsEndpoint
    : endpoint
      ? `${endpoint.replace(/\/+$/, "").replace(/\/v1\/metrics$/, "")}/v1/metrics`
      : "http://localhost:4318/v1/metrics";

  const otlpHeaders = {
    ...parseHeaders(process.env.ATEL_HEADERS || ""),
    ...parseHeaders(process.env.ATEL_METRICS_HEADERS || ""),
  };

  const parsedInterval = parseInt(
    process.env.ATEL_EXPORT_INTERVAL || "60000",
    10
  );
  const exportIntervalMs =
    Number.isFinite(parsedInterval) && parsedInterval > 0
      ? parsedInterval
      : 60000;
  const deviceName = process.env.ATEL_DEVICE_NAME?.trim() || undefined;

  return {
    enabled,
    debug,
    exporters,
    otlpEndpoint,
    otlpHeaders,
    exportIntervalMs,
    deviceName,
  };
}

function parseHeaders(headerStr: string): Record<string, string> {
  if (!headerStr) return {};

  const headers: Record<string, string> = {};
  const pairs = headerStr.split(",");

  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split("=");
    if (key && valueParts.length > 0) {
      headers[key.trim()] = valueParts.join("=").trim();
    }
  }

  return headers;
}
