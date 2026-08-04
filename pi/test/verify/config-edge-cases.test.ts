/**
 * Edge case tests for config parsing
 * Tests unusual inputs and boundary conditions
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig } from "../../src/config.js";

describe("Config Edge Cases", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Strip telemetry vars so a developer's real ATEL_* environment can't leak
    // into assertions about defaults.
    process.env = Object.fromEntries(
      Object.entries(originalEnv).filter(([key]) => !key.startsWith("ATEL_")),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("header parsing edge cases", () => {
    it("handles headers with equals signs in values (like base64)", () => {
      process.env.ATEL_HEADERS = "Authorization=Basic dXNlcjpwYXNz==";
      const config = getConfig("pi");
      expect(config.otlpHeaders).toEqual({
        Authorization: "Basic dXNlcjpwYXNz==",
      });
    });

    it("handles empty header string", () => {
      process.env.ATEL_HEADERS = "";
      const config = getConfig("pi");
      expect(config.otlpHeaders).toEqual({});
    });

    it("handles whitespace around header keys and values", () => {
      process.env.ATEL_HEADERS = " X-Key = value , Y-Key = other ";
      const config = getConfig("pi");
      expect(config.otlpHeaders).toEqual({
        "X-Key": "value",
        "Y-Key": "other",
      });
    });

    it("skips malformed header entries (missing value)", () => {
      process.env.ATEL_HEADERS = "Good=value,BadNoEquals,Another=ok";
      const config = getConfig("pi");
      expect(config.otlpHeaders).toEqual({
        Good: "value",
        Another: "ok",
      });
    });
  });

  describe("exporter parsing", () => {
    it("handles whitespace around exporter names", () => {
      process.env.ATEL_EXPORTERS = " console , otlp ";
      const config = getConfig("pi");
      expect(config.exporters).toEqual(["console", "otlp"]);
    });

    it("handles single exporter", () => {
      process.env.ATEL_EXPORTERS = "otlp";
      const config = getConfig("pi");
      expect(config.exporters).toEqual(["otlp"]);
    });
  });

  describe("export interval parsing", () => {
    // A NaN, zero, or negative interval would misconfigure the metric reader,
    // so each falls back to the 60s default rather than being passed through.
    it("uses default when not a valid number", () => {
      process.env.ATEL_EXPORT_INTERVAL = "not-a-number";
      const config = getConfig("pi");
      expect(config.exportIntervalMs).toBe(60000);
    });

    it("uses default for a zero interval", () => {
      process.env.ATEL_EXPORT_INTERVAL = "0";
      const config = getConfig("pi");
      expect(config.exportIntervalMs).toBe(60000);
    });

    it("uses default for a negative interval", () => {
      process.env.ATEL_EXPORT_INTERVAL = "-1000";
      const config = getConfig("pi");
      expect(config.exportIntervalMs).toBe(60000);
    });
  });

  describe("enable flag variations", () => {
    it("only enables with exact value '1'", () => {
      const testCases = [
        { value: "1", expected: true },
        { value: "true", expected: false },
        { value: "yes", expected: false },
        { value: "TRUE", expected: false },
        { value: "0", expected: false },
        { value: "", expected: false },
      ];

      for (const { value, expected } of testCases) {
        process.env.ATEL_PI = value;
        const config = getConfig("pi");
        expect(config.enabled, `ATEL_PI=${value}`).toBe(expected);
      }
    });
  });

  describe("endpoint fallback chain", () => {
    it("uses default when neither endpoint env var is set", () => {
      delete process.env.ATEL_ENDPOINT;
      delete process.env.ATEL_METRICS_ENDPOINT;
      const config = getConfig("pi");
      expect(config.otlpEndpoint).toBe("http://localhost:4318/v1/metrics");
    });
  });
});
