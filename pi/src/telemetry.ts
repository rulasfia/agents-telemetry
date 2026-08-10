import type { Meter, Counter, Histogram } from "@opentelemetry/api";
import {
  normalizeToolName,
  promptLengthBucket,
  type ToolHarness,
} from "./attributes.js";

export interface UsageData {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TelemetryCollector {
  recordSessionStart(attrs: { sessionId: string; provider?: string; model?: string }): void;
  recordSessionEnd(sessionId?: string): void;
  recordTurnStart(sessionId?: string): void;
  recordTurnEnd(sessionId?: string): void;
  recordToolCall(attrs: { toolCallId?: string; toolName: string; sessionId?: string }): void;
  recordToolResult(attrs: {
    toolCallId?: string;
    toolName: string;
    success: boolean;
    sessionId?: string;
  }): void;
  recordUserPrompt(attrs: { promptLength: number; sessionId?: string }): void;
  recordSkillInvocation(attrs: { skillName: string; sessionId?: string }): void;
  recordUsage(usage: UsageData, sessionId?: string): void;
  /** Update provider/model (e.g., when user switches models mid-session) */
  setProviderModel(provider: string, model: string, sessionId?: string): void;
  getStatus(): TelemetryStatus;
  /** For testing: allows injecting a custom time source */
  _setTimeSource?(fn: () => number): void;
}

export interface DurationStats {
  count: number;
  totalMs: number;
  lastMs: number;
}

export interface TelemetryStatus {
  sessions: number;
  turns: number;
  tools: number;
  prompts: number;
  skills: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  durations: {
    session: DurationStats;
    turn: DurationStats;
    tool: DurationStats;
  };
}

interface Counters {
  sessionCounter: Counter;
  turnCounter: Counter;
  toolCallCounter: Counter;
  toolResultCounter: Counter;
  promptCounter: Counter;
  skillInvocationCounter: Counter;
  tokenCounter: Counter;
  costCounter: Counter;
}

interface Histograms {
  sessionDuration: Histogram;
  turnDuration: Histogram;
  toolDuration: Histogram;
}

export function createTelemetryCollector(
  meter: Meter,
  toolHarness: ToolHarness,
): TelemetryCollector {
  const counters: Counters = {
    sessionCounter: meter.createCounter("pi.session.count", {
      description: "Count of pi coding sessions started",
      unit: "1",
    }),
    turnCounter: meter.createCounter("pi.turn.count", {
      description: "Count of agent turns (tool-calling loops)",
      unit: "1",
    }),
    toolCallCounter: meter.createCounter("pi.tool_call.count", {
      description: "Count of tool invocations",
      unit: "1",
    }),
    toolResultCounter: meter.createCounter("pi.tool_result.count", {
      description: "Count of tool completions",
      unit: "1",
    }),
    promptCounter: meter.createCounter("pi.prompt.count", {
      description: "Count of user prompts submitted",
      unit: "1",
    }),
    skillInvocationCounter: meter.createCounter("pi.skill.invocation.count", {
      description: "Count of skill invocations",
      unit: "1",
    }),
    tokenCounter: meter.createCounter("pi.token.usage", {
      description: "Token usage by type (input/output/cache)",
      unit: "tokens",
    }),
    costCounter: meter.createCounter("pi.cost.usage", {
      description: "Cost in USD by type (input/output/cache)",
      unit: "USD",
    }),
  };

  const histograms: Histograms = {
    sessionDuration: meter.createHistogram("pi.session.duration", {
      description: "Session duration in seconds",
      unit: "s",
    }),
    turnDuration: meter.createHistogram("pi.turn.duration", {
      description: "Turn duration in seconds",
      unit: "s",
    }),
    toolDuration: meter.createHistogram("pi.tool.duration", {
      description: "Tool execution duration in seconds",
      unit: "s",
    }),
  };

  const status: TelemetryStatus = {
    sessions: 0,
    turns: 0,
    tools: 0,
    prompts: 0,
    skills: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    durations: {
      session: { count: 0, totalMs: 0, lastMs: 0 },
      turn: { count: 0, totalMs: 0, lastMs: 0 },
      tool: { count: 0, totalMs: 0, lastMs: 0 },
    },
  };

  interface SessionState {
    provider: string;
    model: string;
    sessionStartTime: number | null;
    turnStartTime: number | null;
    toolStartTimes: Map<string, number>;
  }

  const sessions = new Map<string, SessionState>();
  let defaultSessionId = "";
  const getSession = (sessionId: string) => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        provider: "unknown",
        model: "unknown",
        sessionStartTime: null,
        turnStartTime: null,
        toolStartTimes: new Map(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  };

  // Time source (injectable for testing)
  let now = () => Date.now();

  // Helper to get common attributes including provider/model
  const getBaseAttrs = (sessionId: string) => {
    const session = getSession(sessionId);
    return {
      "session.id": sessionId,
      provider: session.provider,
      model: session.model,
    };
  };

  return {
    recordSessionStart(attrs) {
      defaultSessionId = attrs.sessionId;
      const session = getSession(attrs.sessionId);
      session.provider = attrs.provider ?? "unknown";
      session.model = attrs.model ?? "unknown";
      session.sessionStartTime = now();
      counters.sessionCounter.add(1, getBaseAttrs(attrs.sessionId));
      status.sessions++;
    },

    recordSessionEnd(sessionId) {
      const resolvedSessionId = sessionId ?? defaultSessionId;
      const session = getSession(resolvedSessionId);
      if (session.sessionStartTime !== null) {
        const durationMs = now() - session.sessionStartTime;
        const durationS = durationMs / 1000;
        histograms.sessionDuration.record(durationS, getBaseAttrs(resolvedSessionId));
        status.durations.session.count++;
        status.durations.session.totalMs += durationMs;
        status.durations.session.lastMs = durationMs;
        session.sessionStartTime = null;
      }
      sessions.delete(resolvedSessionId);
      if (resolvedSessionId === defaultSessionId) defaultSessionId = "";
    },

    recordTurnStart(sessionId) {
      const resolvedSessionId = sessionId ?? defaultSessionId;
      const session = getSession(resolvedSessionId);
      session.turnStartTime = now();
      counters.turnCounter.add(1, getBaseAttrs(resolvedSessionId));
      status.turns++;
    },

    recordTurnEnd(sessionId) {
      const resolvedSessionId = sessionId ?? defaultSessionId;
      const session = getSession(resolvedSessionId);
      if (session.turnStartTime !== null) {
        const durationMs = now() - session.turnStartTime;
        const durationS = durationMs / 1000;
        histograms.turnDuration.record(durationS, getBaseAttrs(resolvedSessionId));
        status.durations.turn.count++;
        status.durations.turn.totalMs += durationMs;
        status.durations.turn.lastMs = durationMs;
        session.turnStartTime = null;
      }
    },

    recordToolCall(attrs) {
      const sessionId = attrs.sessionId ?? defaultSessionId;
      const session = getSession(sessionId);
      const toolName = normalizeToolName(toolHarness, attrs.toolName);
      session.toolStartTimes.set(attrs.toolCallId ?? toolName, now());
      counters.toolCallCounter.add(1, {
        ...getBaseAttrs(sessionId),
        "tool.name": toolName,
      });
      status.tools++;
    },

    recordToolResult(attrs) {
      const sessionId = attrs.sessionId ?? defaultSessionId;
      const session = getSession(sessionId);
      const toolName = normalizeToolName(toolHarness, attrs.toolName);
      const toolKey = attrs.toolCallId ?? toolName;
      const startTime = session.toolStartTimes.get(toolKey);
      if (startTime !== undefined) {
        const durationMs = now() - startTime;
        const durationS = durationMs / 1000;
        histograms.toolDuration.record(durationS, {
          ...getBaseAttrs(sessionId),
          "tool.name": toolName,
          success: String(attrs.success),
        });
        status.durations.tool.count++;
        status.durations.tool.totalMs += durationMs;
        status.durations.tool.lastMs = durationMs;
        session.toolStartTimes.delete(toolKey);
      }
      counters.toolResultCounter.add(1, {
        ...getBaseAttrs(sessionId),
        "tool.name": toolName,
        success: String(attrs.success),
      });
    },

    recordUserPrompt(attrs) {
      const sessionId = attrs.sessionId ?? defaultSessionId;
      counters.promptCounter.add(1, {
        ...getBaseAttrs(sessionId),
        "prompt.length.bucket": promptLengthBucket(attrs.promptLength),
      });
      status.prompts++;
    },

    setProviderModel(provider: string, model: string, sessionId) {
      const session = getSession(sessionId ?? defaultSessionId);
      session.provider = provider;
      session.model = model;
    },

    recordSkillInvocation(attrs) {
      const sessionId = attrs.sessionId ?? defaultSessionId;
      counters.skillInvocationCounter.add(1, {
        ...getBaseAttrs(sessionId),
        "skill.name": normalizeToolName(toolHarness, attrs.skillName),
      });
      status.skills++;
    },

    recordUsage(usage, sessionId) {
      const baseAttrs = getBaseAttrs(sessionId ?? defaultSessionId);

      counters.tokenCounter.add(usage.input, { ...baseAttrs, type: "input" });
      counters.tokenCounter.add(usage.output, { ...baseAttrs, type: "output" });
      counters.tokenCounter.add(usage.cacheRead, { ...baseAttrs, type: "cache_read" });
      counters.tokenCounter.add(usage.cacheWrite, { ...baseAttrs, type: "cache_write" });

      if (usage.cost) {
        counters.costCounter.add(usage.cost.input, { ...baseAttrs, type: "input" });
        counters.costCounter.add(usage.cost.output, { ...baseAttrs, type: "output" });
        counters.costCounter.add(usage.cost.cacheRead, { ...baseAttrs, type: "cache_read" });
        counters.costCounter.add(usage.cost.cacheWrite, { ...baseAttrs, type: "cache_write" });
      }

      status.tokens.input += usage.input;
      status.tokens.output += usage.output;
      status.tokens.cacheRead += usage.cacheRead;
      status.tokens.cacheWrite += usage.cacheWrite;
      status.tokens.total += usage.totalTokens;

      if (usage.cost) {
        status.cost.input += usage.cost.input;
        status.cost.output += usage.cost.output;
        status.cost.cacheRead += usage.cost.cacheRead;
        status.cost.cacheWrite += usage.cost.cacheWrite;
        status.cost.total += usage.cost.total;
      }
    },

    getStatus() {
      return {
        ...status,
        tokens: { ...status.tokens },
        cost: { ...status.cost },
        durations: {
          session: { ...status.durations.session },
          turn: { ...status.durations.turn },
          tool: { ...status.durations.tool },
        },
      };
    },

    _setTimeSource(fn: () => number) {
      now = fn;
    },
  };
}
