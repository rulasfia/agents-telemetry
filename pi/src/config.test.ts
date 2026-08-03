import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig } from "./config.js";

describe("getConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Strip telemetry vars so a developer's real PI_OTLP_*/OTEL_* environment
    // can't leak into assertions about defaults.
    process.env = Object.fromEntries(
      Object.entries(originalEnv).filter(
        ([key]) => !key.startsWith("PI_OTLP_") && !key.startsWith("OTEL_"),
      ),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns disabled by default", () => {
    delete process.env.PI_OTLP_ENABLE;
    const config = getConfig();
    expect(config.enabled).toBe(false);
  });

  it("enables when PI_OTLP_ENABLE=1", () => {
    process.env.PI_OTLP_ENABLE = "1";
    const config = getConfig();
    expect(config.enabled).toBe(true);
  });

  it("parses OTEL_METRICS_EXPORTER", () => {
    process.env.OTEL_METRICS_EXPORTER = "console,otlp";
    const config = getConfig();
    expect(config.exporters).toEqual(["console", "otlp"]);
  });

  it("defaults to console exporter", () => {
    delete process.env.OTEL_METRICS_EXPORTER;
    const config = getConfig();
    expect(config.exporters).toEqual(["console"]);
  });

  it("appends /v1/metrics to OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
    const config = getConfig();
    expect(config.otlpEndpoint).toBe("http://collector:4318/v1/metrics");
  });

  it("preserves a metrics endpoint exactly", () => {
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://collector:4318/custom";
    const config = getConfig();
    expect(config.otlpEndpoint).toBe("http://collector:4318/custom");
  });

  it("prefers OTEL_EXPORTER_OTLP_METRICS_ENDPOINT over general endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://general:4318";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://metrics:4318";
    const config = getConfig();
    expect(config.otlpEndpoint).toBe("http://metrics:4318");
  });

  it("appends /v1/metrics to PI_OTLP_ENDPOINT", () => {
    process.env.PI_OTLP_ENDPOINT = "http://homeserver:4318";
    const config = getConfig();
    expect(config.otlpEndpoint).toBe("http://homeserver:4318/v1/metrics");
  });

  it("preserves PI_OTLP_METRICS_ENDPOINT exactly", () => {
    process.env.PI_OTLP_METRICS_ENDPOINT = "http://homeserver:4318/custom";
    const config = getConfig();
    expect(config.otlpEndpoint).toBe("http://homeserver:4318/custom");
  });

  it("prefers OTEL endpoints over PI_OTLP fallbacks", () => {
    process.env.PI_OTLP_ENDPOINT = "http://fallback:4318";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://primary:4318";
    const config = getConfig();
    expect(config.otlpEndpoint).toBe("http://primary:4318/v1/metrics");
  });

  it("uses metrics headers in preference to general OTLP headers", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer token,X-Api-Key=key123";
    process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = "Authorization=Bearer metrics-token";
    const config = getConfig();
    expect(config.otlpHeaders).toEqual({
      Authorization: "Bearer metrics-token",
      "X-Api-Key": "key123",
    });
  });

  it("parses OTEL_METRIC_EXPORT_INTERVAL", () => {
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "5000";
    const config = getConfig();
    expect(config.exportIntervalMs).toBe(5000);
  });

  it("falls back to the default interval when unparseable", () => {
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "not-a-number";
    const config = getConfig();
    expect(config.exportIntervalMs).toBe(60000);
  });

  it("uses a trimmed device name when configured", () => {
    process.env.PI_OTLP_DEVICE_NAME = "  desktop  ";
    const config = getConfig();
    expect(config.deviceName).toBe("desktop");
  });

  it("omits an empty device name", () => {
    process.env.PI_OTLP_DEVICE_NAME = "   ";
    const config = getConfig();
    expect(config.deviceName).toBeUndefined();
  });
});
