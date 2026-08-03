export interface OtlpConfig {
  enabled: boolean;
  debug: boolean;
  exporters: ("console" | "otlp")[];
  otlpEndpoint: string;
  otlpHeaders: Record<string, string>;
  exportIntervalMs: number;
  deviceName?: string;
}

export function getConfig(): OtlpConfig {
  const enabled = process.env.PI_OTLP_ENABLE === "1";
  const debug = process.env.PI_OTLP_DEBUG === "1";

  const exporterStr = process.env.OTEL_METRICS_EXPORTER ?? "console";
  const exporters = exporterStr.split(",").map((e) => e.trim()) as ("console" | "otlp")[];

  // Claude Code strips OTEL_* env vars from hook subprocesses, so PI_* fallbacks
  // allow the same endpoint config to work across both pi and Claude Code.
  // PI_OTLP_ENDPOINT mirrors OTEL_EXPORTER_OTLP_ENDPOINT (a base URL that gets
  // /v1/metrics appended); PI_OTLP_METRICS_ENDPOINT mirrors the signal-specific
  // variant and is used verbatim. Wiring PI_OTLP_ENDPOINT into both slots would
  // make the base form win the verbatim branch and skip /v1/metrics entirely.
  const metricsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
    process.env.PI_OTLP_METRICS_ENDPOINT;
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.PI_OTLP_ENDPOINT;
  const otlpEndpoint = metricsEndpoint
    ? metricsEndpoint
    : endpoint
      ? `${endpoint.replace(/\/+$/, "").replace(/\/v1\/metrics$/, "")}/v1/metrics`
      : "http://localhost:4318/v1/metrics";

  const otlpHeaders = {
    ...parseHeaders(
      process.env.OTEL_EXPORTER_OTLP_HEADERS ||
        process.env.PI_OTLP_HEADERS ||
        ""
    ),
    ...parseHeaders(
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ||
        process.env.PI_OTLP_METRICS_HEADERS ||
        ""
    ),
  };

  const parsedInterval = parseInt(
    process.env.OTEL_METRIC_EXPORT_INTERVAL ||
      process.env.PI_OTLP_EXPORT_INTERVAL ||
      "60000",
    10
  );
  const exportIntervalMs =
    Number.isFinite(parsedInterval) && parsedInterval > 0
      ? parsedInterval
      : 60000;
  const deviceName = process.env.PI_OTLP_DEVICE_NAME?.trim() || undefined;

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
