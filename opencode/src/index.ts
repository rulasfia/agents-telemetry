import { diag, DiagLogLevel } from "@opentelemetry/api";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { Plugin } from "@opencode-ai/plugin";
import { getConfig } from "../../pi/src/config.js";
import { createTelemetryCollector } from "../../pi/src/telemetry.js";

const SERVICE_NAME = "pi-otlp-opencode";
const VERSION = "0.7.1";

export default Plugin.define({
  id: "rulasfia.agents-telemetry",
  setup: async (ctx) => {
    const config = getConfig("opencode");
    if (!config.enabled) return;

    if (config.debug) {
      const log = (level: "debug" | "info" | "warn" | "error") =>
        (...args: unknown[]) => console[level]("[ATEL]", ...args);
      diag.setLogger({
        verbose: log("debug"),
        debug: log("debug"),
        info: log("info"),
        warn: log("warn"),
        error: log("error"),
      }, DiagLogLevel.DEBUG);
    }

    const readers = [];
    if (config.exporters.includes("console") || config.debug) {
      readers.push(new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: config.exportIntervalMs,
      }));
    }
    if (config.exporters.includes("otlp")) {
      readers.push(new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: config.otlpEndpoint,
          headers: config.otlpHeaders,
        }),
        exportIntervalMillis: config.exportIntervalMs,
      }));
    }
    if (readers.length === 0) return;

    const provider = new MeterProvider({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: VERSION,
        "os.type": process.platform,
        "host.arch": process.arch,
        ...(config.deviceName ? { "device.name": config.deviceName } : {}),
      }),
      readers,
    });
    const collector = createTelemetryCollector(provider.getMeter("com.pi.otlp"), "oc");
    const toolNames = new Map<string, string>();
    const activeSessions = new Set<string>();
    const controller = new AbortController();

    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          switch (event.type) {
            case "session.created":
              activeSessions.add(event.data.sessionID);
              collector.recordSessionStart({
                sessionId: event.data.sessionID,
                provider: event.data.model?.providerID,
                model: event.data.model?.id,
              });
              break;
            case "session.deleted":
              collector.recordSessionEnd(event.data.sessionID);
              activeSessions.delete(event.data.sessionID);
              break;
            case "session.model.selected":
              collector.setProviderModel(event.data.model.providerID, event.data.model.id, event.data.sessionID);
              break;
            case "session.input.admitted":
              if (event.data.input.type === "user") {
                collector.recordUserPrompt({
                  sessionId: event.data.sessionID,
                  promptLength: event.data.input.data.text.length,
                });
              }
              break;
            case "session.skill.activated":
              collector.recordSkillInvocation({
                sessionId: event.data.sessionID,
                skillName: event.data.id,
              });
              break;
            case "session.execution.started":
              collector.recordTurnStart(event.data.sessionID);
              break;
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              collector.recordTurnEnd(event.data.sessionID);
              break;
            case "session.step.ended":
              collector.recordUsage({
                input: event.data.tokens.input,
                output: event.data.tokens.output + event.data.tokens.reasoning,
                cacheRead: event.data.tokens.cache.read,
                cacheWrite: event.data.tokens.cache.write,
                totalTokens: event.data.tokens.input + event.data.tokens.output + event.data.tokens.reasoning + event.data.tokens.cache.read + event.data.tokens.cache.write,
              }, event.data.sessionID);
              break;
            case "session.tool.input.started":
              toolNames.set(event.data.id, event.data.name);
              collector.recordToolCall({
                sessionId: event.data.sessionID,
                toolCallId: event.data.id,
                toolName: event.data.name,
              });
              break;
            case "session.tool.success":
            case "session.tool.failed": {
              const toolName = toolNames.get(event.data.id) ?? "unknown";
              collector.recordToolResult({
                sessionId: event.data.sessionID,
                toolCallId: event.data.id,
                toolName,
                success: event.type === "session.tool.success",
              });
              toolNames.delete(event.data.id);
              break;
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && config.debug) console.error("[ATEL] OpenCode event stream failed", error);
      }
    })();

    return async () => {
      controller.abort();
      for (const sessionId of activeSessions) collector.recordSessionEnd(sessionId);
      await provider.shutdown();
      await events;
    };
  },
});
