import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig } from "./config.js";

describe("getConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Strip telemetry vars so a developer's real environment can't leak into
    // assertions about defaults. OTEL_*/PI_OTLP_* are stripped too, so the
    // "ignores legacy names" tests below can set them deliberately.
    process.env = Object.fromEntries(
      Object.entries(originalEnv).filter(
        ([key]) =>
          !key.startsWith("ATEL_") &&
          !key.startsWith("PI_OTLP_") &&
          !key.startsWith("OTEL_"),
      ),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns disabled by default", () => {
    expect(getConfig("pi").enabled).toBe(false);
    expect(getConfig("claude-code").enabled).toBe(false);
    expect(getConfig("opencode").enabled).toBe(false);
  });

  it("enables the pi extension with ATEL_PI=1", () => {
    process.env.ATEL_PI = "1";
    expect(getConfig("pi").enabled).toBe(true);
  });

  it("enables the Claude Code bridge with ATEL_CLAUDE_CODE=1", () => {
    process.env.ATEL_CLAUDE_CODE = "1";
    expect(getConfig("claude-code").enabled).toBe(true);
  });

  it("enables the OpenCode plugin with ATEL_OPENCODE=1", () => {
    process.env.ATEL_OPENCODE = "1";
    expect(getConfig("opencode").enabled).toBe(true);
  });

  it("keeps enablement independent per emitter", () => {
    // The whole reason enablement is not shared: running telemetry for one
    // agent must not silently switch on the other.
    process.env.ATEL_PI = "1";
    expect(getConfig("pi").enabled).toBe(true);
    expect(getConfig("claude-code").enabled).toBe(false);
  });

  it("shares non-enablement config across both emitters", () => {
    process.env.ATEL_ENDPOINT = "http://collector:4318";
    process.env.ATEL_DEVICE_NAME = "desktop";
    const pi = getConfig("pi");
    const claude = getConfig("claude-code");
    expect(pi.otlpEndpoint).toBe(claude.otlpEndpoint);
    expect(pi.deviceName).toBe(claude.deviceName);
    expect(pi.exporters).toEqual(claude.exporters);
  });

  it("parses ATEL_EXPORTERS", () => {
    process.env.ATEL_EXPORTERS = "console,otlp";
    expect(getConfig("pi").exporters).toEqual(["console", "otlp"]);
  });

  it("defaults to the otlp exporter", () => {
    expect(getConfig("pi").exporters).toEqual(["otlp"]);
  });

  it("ignores blank entries in ATEL_EXPORTERS", () => {
    process.env.ATEL_EXPORTERS = "console,,";
    expect(getConfig("pi").exporters).toEqual(["console"]);
  });

  it("appends /v1/metrics to ATEL_ENDPOINT", () => {
    process.env.ATEL_ENDPOINT = "http://collector:4318";
    expect(getConfig("pi").otlpEndpoint).toBe("http://collector:4318/v1/metrics");
  });

  it("does not double-append /v1/metrics or trailing slashes", () => {
    process.env.ATEL_ENDPOINT = "http://collector:4318/v1/metrics/";
    expect(getConfig("pi").otlpEndpoint).toBe("http://collector:4318/v1/metrics");
  });

  it("preserves ATEL_METRICS_ENDPOINT exactly", () => {
    process.env.ATEL_METRICS_ENDPOINT = "http://collector:4318/custom";
    expect(getConfig("pi").otlpEndpoint).toBe("http://collector:4318/custom");
  });

  it("prefers ATEL_METRICS_ENDPOINT over ATEL_ENDPOINT", () => {
    process.env.ATEL_ENDPOINT = "http://general:4318";
    process.env.ATEL_METRICS_ENDPOINT = "http://metrics:4318";
    expect(getConfig("pi").otlpEndpoint).toBe("http://metrics:4318");
  });

  it("defaults the endpoint to localhost:4318", () => {
    expect(getConfig("pi").otlpEndpoint).toBe("http://localhost:4318/v1/metrics");
  });

  it("uses metrics headers in preference to general headers", () => {
    process.env.ATEL_HEADERS = "Authorization=Bearer token,X-Api-Key=key123";
    process.env.ATEL_METRICS_HEADERS = "Authorization=Bearer metrics-token";
    expect(getConfig("pi").otlpHeaders).toEqual({
      Authorization: "Bearer metrics-token",
      "X-Api-Key": "key123",
    });
  });

  it("parses ATEL_EXPORT_INTERVAL", () => {
    process.env.ATEL_EXPORT_INTERVAL = "5000";
    expect(getConfig("pi").exportIntervalMs).toBe(5000);
  });

  it("falls back to the default interval when unparseable", () => {
    process.env.ATEL_EXPORT_INTERVAL = "not-a-number";
    expect(getConfig("pi").exportIntervalMs).toBe(60000);
  });

  it("enables debug with ATEL_DEBUG=1", () => {
    process.env.ATEL_DEBUG = "1";
    expect(getConfig("pi").debug).toBe(true);
  });

  it("uses a trimmed device name when configured", () => {
    process.env.ATEL_DEVICE_NAME = "  desktop  ";
    expect(getConfig("pi").deviceName).toBe("desktop");
  });

  it("omits an empty device name", () => {
    process.env.ATEL_DEVICE_NAME = "   ";
    expect(getConfig("pi").deviceName).toBeUndefined();
  });

  it("ignores the legacy PI_OTLP_* names", () => {
    process.env.PI_OTLP_ENABLE = "1";
    process.env.PI_OTLP_ENDPOINT = "http://legacy:4318";
    process.env.PI_OTLP_DEVICE_NAME = "legacy";
    const config = getConfig("pi");
    expect(config.enabled).toBe(false);
    expect(config.otlpEndpoint).toBe("http://localhost:4318/v1/metrics");
    expect(config.deviceName).toBeUndefined();
  });

  it("ignores the standard OTEL_* names", () => {
    // Dropped on purpose: Claude Code strips OTEL_* from hook subprocesses, so
    // honouring it would configure one emitter and not the other.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel:4318";
    process.env.OTEL_METRICS_EXPORTER = "console";
    const config = getConfig("pi");
    expect(config.otlpEndpoint).toBe("http://localhost:4318/v1/metrics");
    expect(config.exporters).toEqual(["otlp"]);
  });
});
