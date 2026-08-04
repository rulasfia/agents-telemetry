import { diag, DiagLogLevel } from "@opentelemetry/api";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { promptLengthBucket } from "../../pi/src/attributes.js";
import { getConfig, type OtlpConfig } from "../../pi/src/config.js";
import {
  readLastModel,
  readTranscriptDelta,
  transcriptSize,
} from "./transcript.js";
import { VERSION } from "./version.js";

const SERVICE_NAME = "pi-otlp-claude";
const STATE_DIR = join(homedir(), ".pi", "otlp-claude");
const STALE_STATE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Longest a synchronous hook may block on the exporter. Telemetry must never
 * be felt in the session, so an unreachable collector costs a datapoint rather
 * than the user's time.
 */
const FLUSH_TIMEOUT_MS = 3000;

interface State {
  sessionStartTime?: number;
  provider?: string;
  model?: string;
  turnStartTime?: number;
  /** Byte offset into the transcript already accounted for in token metrics. */
  transcriptOffset?: number;
}

/**
 * State is keyed by session id. A single shared file would be corrupted by
 * concurrent sessions, and one session's SessionEnd would wipe another's.
 */
function stateFile(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return join(STATE_DIR, `${safe || "unknown"}.json`);
}

function readState(sessionId: string): State {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf-8")) as State;
  } catch {
    return {};
  }
}

function writeState(sessionId: string, state: State) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const file = stateFile(sessionId);
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch {
    // Silently fail if we can't write state.
  }
}

function clearState(sessionId: string) {
  try {
    rmSync(stateFile(sessionId), { force: true });
  } catch {
    // Best effort.
  }
}

/** Drop state left behind by sessions that never emitted SessionEnd. */
function pruneStaleState(now: number) {
  try {
    for (const name of readdirSync(STATE_DIR)) {
      const file = join(STATE_DIR, name);
      if (now - statSync(file).mtimeMs > STALE_STATE_MS) {
        rmSync(file, { force: true });
      }
    }
  } catch {
    // Directory may not exist yet; nothing to prune.
  }
}

function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve) => {
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
  });
}

function createMeterProvider(config: OtlpConfig) {
  if (config.debug) {
    const log =
      (level: string) =>
      (...args: unknown[]) =>
        console.error(`[OTLP:${level}]`, ...args);
    diag.setLogger(
      {
        verbose: log("verbose"),
        debug: log("debug"),
        info: log("info"),
        warn: log("warn"),
        error: log("error"),
      },
      DiagLogLevel.DEBUG,
    );
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: VERSION,
    "os.type": process.platform,
    "host.arch": process.arch,
    ...(config.deviceName ? { "device.name": config.deviceName } : {}),
  });

  const readers = [];

  // SessionStart, Stop and SessionEnd run synchronously, so the forceFlush in
  // main() sits on the user's critical path. What actually stalled a session
  // against an unreachable collector was the *reader's* export timeout, which
  // defaults to 30s — capping only the exporter's own request timeout is not
  // enough, since the reader wraps the whole export cycle.
  //
  // The reader also throws if exportTimeoutMillis > exportIntervalMillis, and
  // ATEL_EXPORT_INTERVAL is user-settable (validated only as > 0), so clamp
  // instead of trusting the pair: a throw here is swallowed by main()'s catch
  // and would silently disable telemetry rather than fail loudly.
  const exportTimeoutMillis = Math.min(
    FLUSH_TIMEOUT_MS,
    config.exportIntervalMs,
  );

  // ATEL_EXPORTERS is honoured here exactly as in the pi extension. The older
  // OTEL_METRICS_EXPORTER could not be, because Claude Code strips OTEL_* from
  // hook subprocesses; ATEL_* survives, so both emitters now read one variable.
  // Debug adds console on top, since a short-lived process leaves no other trace.
  if (config.exporters.includes("console") || config.debug) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: config.exportIntervalMs,
        exportTimeoutMillis,
      }),
    );
  }

  if (config.exporters.includes("otlp")) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: config.otlpEndpoint,
          headers: config.otlpHeaders,
          // Every hook event runs in a fresh process, so a cumulative counter
          // would restart at zero and report 1 forever — Prometheus would see a
          // flat series and increase()/rate() would return nothing. Delta lets
          // the collector stitch the per-process contributions together.
          temporalityPreference: AggregationTemporalityPreference.DELTA,
          // Caps the HTTP request itself; the reader timeout below caps the
          // export cycle around it. Losing a datapoint beats a stalled
          // prompt, so this does not retry.
          timeoutMillis: FLUSH_TIMEOUT_MS,
        }),
        exportIntervalMillis: config.exportIntervalMs,
        exportTimeoutMillis,
      }),
    );
  }

  if (readers.length === 0) return null;

  return new MeterProvider({ resource, readers });
}

/**
 * Run `work`, but stop waiting after `ms`. Never rejects.
 *
 * The abandoned work keeps running; `process.exit` at the bottom of this file
 * is what actually reclaims it. This only guarantees the hook stops blocking.
 */
function settleWithin(work: () => Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work().then(done, done);
  });
}

function baseAttrs(sessionId: string, state: State) {
  return {
    "session.id": sessionId,
    provider: state.provider ?? "anthropic",
    model: state.model ?? "unknown",
  };
}

async function main() {
  const config = getConfig("claude-code");
  if (!config.enabled) return;

  const rawEvent = await readStdin();
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawEvent) as Record<string, unknown>;
  } catch {
    if (config.debug) console.error("[OTLP] Failed to parse event JSON");
    return;
  }

  const eventName = event.hook_event_name as string | undefined;
  const sessionId = (event.session_id as string | undefined) ?? "unknown";
  if (!eventName) return;

  const state = readState(sessionId);
  const now = Date.now();

  // Metrics are staged so the provider is only built when there is something
  // to send — PreToolUse-style no-op events skip the exporter entirely.
  type Emit = (meter: ReturnType<MeterProvider["getMeter"]>) => void;
  const emits: Emit[] = [];
  let persist = true;

  switch (eventName) {
    case "SessionStart": {
      pruneStaleState(now);

      // Start reading at end-of-file, not byte 0. SessionStart fires with
      // source "startup" | "clear" | "resume" | "fork" | "compact", and in
      // every case but startup the transcript already holds messages whose
      // usage was reported by a previous session — or, after compaction, by
      // this very session. Resetting to 0 makes the next Stop re-sum all of
      // it and double the token totals. Seeking to the current size is the
      // one rule that is correct for every source: on startup the file is
      // empty or absent, so this is still 0. A missing transcript_path falls
      // back to the stored offset rather than 0, which is safer on resume.
      const startTranscript = event.transcript_path as string | undefined;
      state.transcriptOffset = startTranscript
        ? transcriptSize(startTranscript)
        : (state.transcriptOffset ?? 0);

      // Compaction is the only source that fires mid-session, under the same
      // session id, so it alone inherits the running clock and must not count
      // a second session. Every other source is a new process: it starts a
      // fresh clock even when state survived, because SessionEnd is not
      // guaranteed to have fired (see pruneStaleState) and inheriting a
      // days-old sessionStartTime would report that gap as session duration.
      const source = event.source as string | undefined;
      const isNewSession = source !== "compact";
      if (isNewSession || state.sessionStartTime === undefined) {
        state.sessionStartTime = now;
      }

      const modelField = event.model as
        | Record<string, string>
        | string
        | undefined;
      if (typeof modelField === "object" && modelField !== null) {
        state.provider = modelField.provider ?? "anthropic";
        state.model = modelField.id ?? "unknown";
      } else if (typeof modelField === "string") {
        state.provider = "anthropic";
        state.model = modelField;
      } else {
        state.provider = "anthropic";
        state.model = process.env.ANTHROPIC_MODEL ?? "unknown";
      }

      if (isNewSession) {
        const attrs = baseAttrs(sessionId, state);
        emits.push((meter) =>
          meter
            .createCounter("pi.session.count", {
              description: "Count of pi coding sessions started",
              unit: "1",
            })
            .add(1, attrs),
        );
      }
      break;
    }

    case "UserPromptSubmit": {
      state.turnStartTime = now;
      const promptText = (event.prompt as string | undefined) ?? "";
      const attrs = baseAttrs(sessionId, state);
      emits.push((meter) =>
        meter
          .createCounter("pi.prompt.count", {
            description: "Count of user prompts submitted",
            unit: "1",
          })
          .add(1, {
            ...attrs,
            "prompt.length.bucket": promptLengthBucket(promptText.length),
          }),
      );
      break;
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      persist = false; // Tool events never mutate state, so they can't race.
      const toolName = event.tool_name as string | undefined;
      if (!toolName) break;
      const success = eventName === "PostToolUse";

      // SessionStart reports no model, so the first turn's events would be
      // labelled model=unknown. The assistant message that requested this tool
      // is already in the transcript; scan for it until the model is known.
      const transcript = event.transcript_path as string | undefined;
      if (!state.model || state.model === "unknown") {
        if (transcript) state.model = readLastModel(transcript) ?? state.model;
      }
      const attrs = baseAttrs(sessionId, state);

      // Claude Code reports the tool's own duration, so there is no need to
      // stash a start time at PreToolUse — which also means parallel tool
      // calls can't race each other through a shared state file.
      const durationMs = Number(event.duration_ms ?? NaN);
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        emits.push((meter) =>
          meter
            .createHistogram("pi.tool.duration", {
              description: "Tool execution duration in seconds",
              unit: "s",
            })
            .record(durationMs / 1000, {
              ...attrs,
              "tool.name": toolName,
              success: String(success),
            }),
        );
      }

      emits.push((meter) => {
        meter
          .createCounter("pi.tool_call.count", {
            description: "Count of tool invocations",
            unit: "1",
          })
          .add(1, { ...attrs, "tool.name": toolName });
        meter
          .createCounter("pi.tool_result.count", {
            description: "Count of tool completions",
            unit: "1",
          })
          .add(1, {
            ...attrs,
            "tool.name": toolName,
            success: String(success),
          });
      });
      break;
    }

    case "Stop": {
      const turnStartTime = state.turnStartTime;
      state.turnStartTime = undefined;

      const transcriptPath = event.transcript_path as string | undefined;
      if (transcriptPath) {
        const delta = readTranscriptDelta(
          transcriptPath,
          state.transcriptOffset ?? 0,
        );
        state.transcriptOffset = delta.offset;
        // The transcript carries the resolved model id, which is more precise
        // than whatever SessionStart reported.
        if (delta.model) state.model = delta.model;

        const total =
          delta.input + delta.output + delta.cacheRead + delta.cacheWrite;
        if (total > 0) {
          const attrs = baseAttrs(sessionId, state);
          emits.push((meter) => {
            const tokens = meter.createCounter("pi.token.usage", {
              description: "Token usage by type",
              unit: "tokens",
            });
            tokens.add(delta.input, { ...attrs, type: "input" });
            tokens.add(delta.output, { ...attrs, type: "output" });
            tokens.add(delta.cacheRead, { ...attrs, type: "cache_read" });
            tokens.add(delta.cacheWrite, { ...attrs, type: "cache_write" });
          });
        }
      }

      // Claude Code hook events do not expose cost data, so pi.cost.usage is
      // not emitted here; use Claude Code's native claude_code.cost.usage.
      if (turnStartTime) {
        const attrs = baseAttrs(sessionId, state);
        emits.push((meter) => {
          meter
            .createHistogram("pi.turn.duration", {
              description: "Turn duration in seconds",
              unit: "s",
            })
            .record((now - turnStartTime) / 1000, attrs);
          meter
            .createCounter("pi.turn.count", {
              description: "Count of agent turns",
              unit: "1",
            })
            .add(1, attrs);
        });
      }
      break;
    }

    case "SessionEnd": {
      persist = false;
      const sessionStartTime = state.sessionStartTime;
      if (sessionStartTime) {
        const attrs = baseAttrs(sessionId, state);
        emits.push((meter) =>
          meter
            .createHistogram("pi.session.duration", {
              description: "Session duration in seconds",
              unit: "s",
            })
            .record((now - sessionStartTime) / 1000, attrs),
        );
      }
      clearState(sessionId);
      break;
    }

    default:
      persist = false;
  }

  if (persist) writeState(sessionId, state);
  if (emits.length === 0) return;

  const meterProvider = createMeterProvider(config);
  if (!meterProvider) return;
  try {
    const meter = meterProvider.getMeter("com.pi.otlp.claude");
    for (const emit of emits) emit(meter);
  } finally {
    // Bound the teardown ourselves rather than trusting the SDK's own timeout.
    // When the reader's export timeout fires it abandons the in-flight request
    // without cancelling it, then PeriodicExportingMetricReader.onForceFlush
    // still awaits exporter.forceFlush() — which stays pending for as long as
    // the socket does. Against an unreachable collector that means forceFlush()
    // never settles, so no timeout configured *inside* the SDK can help.
    await settleWithin(async () => {
      try {
        await meterProvider.forceFlush();
      } catch {
        // Ignore flush errors so we don't block Claude Code.
      }
      try {
        await meterProvider.shutdown();
      } catch {
        // Ignore shutdown errors.
      }
    }, FLUSH_TIMEOUT_MS);
  }
}

main()
  .catch((err) => {
    // Exit 0 regardless: a non-zero hook exit surfaces as a visible failure in
    // Claude Code, and telemetry should never interrupt the session.
    if (process.env.ATEL_DEBUG === "1") {
      console.error("[OTLP] Bridge error:", err);
    }
  })
  .finally(() => {
    // Capping the export timeout is not enough on its own: a connect attempt
    // to an unreachable collector keeps its socket, and therefore the event
    // loop, alive for the full TCP SYN-retry window (~2 min on Linux) long
    // after the exporter gave up at FLUSH_TIMEOUT_MS. Returning from main()
    // means the work is done, so exit rather than let a dead socket hold a
    // synchronous hook — and the user's session — open.
    //
    // This can truncate console-exporter output when the collector is also
    // unreachable, which only affects debug runs.
    process.exit(0);
  });
