/**
 * Drive the pi extension through a full session against the dev collector.
 *
 *   npm run dev:pi
 *
 * pi-coding-agent loads the extension from source and never exits between
 * events, so unlike the Claude bridge this runs in a single process with
 * cumulative temporality — the same shape pi produces in real use.
 *
 * The event names here are the ones pi/src/index.ts actually subscribes to.
 * (pi/test/verify/integration-demo.ts still emits the older tool_call /
 * tool_result names, which the extension no longer listens for.)
 */
import extension from "../pi/src/index.js";

type Handler = (event: any, ctx: any) => Promise<void>;

const handlers = new Map<string, Handler>();
const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();

const model = { provider: "anthropic", id: "claude-opus-5" };

const ctx = {
  sessionManager: { getSessionId: () => process.env.DEV_SESSION_ID ?? `dev-pi-${Date.now()}` },
  model,
  ui: { notify: async (msg: string) => console.log(`[notify] ${msg}`) },
};

const pi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
    commands.set(name, opts);
  },
};

async function emit(event: string, data: Record<string, unknown> = {}) {
  const handler = handlers.get(event);
  if (!handler) {
    console.log(`  ! no handler for ${event}`);
    return;
  }
  console.log(`  → ${event}`);
  await handler(data, ctx);
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    // The extension reads cost straight off the message, so pi.cost.usage is
    // exercised here even though the Claude bridge can never emit it.
    cost: { input: 0.012, output: 0.017, cacheRead: 0.0008, cacheWrite: 0.00125, total: 0.03105 },
  };
}

async function main() {
  extension(pi as any);

  if (handlers.size === 0) {
    console.error("Extension registered no handlers — is ATEL_PI=1 set?");
    process.exit(1);
  }

  console.log(`Simulating a pi session (${handlers.size} handlers registered)\n`);

  await emit("session_start");
  await emit("model_select", { model });

  for (let turn = 1; turn <= 3; turn++) {
    console.log(`\n-- turn ${turn} --`);
    await emit("turn_start");
    await emit("input", { text: turn === 1 ? "/skill:code-review inspect this project" : `prompt number ${turn}` });

    await emit("tool_execution_start", {
      toolCallId: `call-${turn}-a`,
      toolName: "Read",
      ...(turn === 2 ? { args: { path: ".agents/skills/find-skills/SKILL.md" } } : {}),
    });
    await new Promise((r) => setTimeout(r, 25));
    await emit("tool_execution_end", { toolCallId: `call-${turn}-a`, toolName: "Read", isError: false });

    await emit("tool_execution_start", { toolCallId: `call-${turn}-b`, toolName: "Bash" });
    await new Promise((r) => setTimeout(r, 40));
    // One failure across the run, so the success=false branch is covered.
    await emit("tool_execution_end", { toolCallId: `call-${turn}-b`, toolName: "Bash", isError: turn === 2 });

    await emit("turn_end", {
      message: { role: "assistant", usage: usage(1200, 340, 8000, 500) },
    });
  }

  const status = commands.get("otlp-status");
  if (status) {
    console.log("\n-- /otlp-status --");
    await status.handler("", ctx);
  }

  console.log("\n-- shutdown (flushes the exporter) --");
  await emit("session_shutdown");

  console.log("\nExpected totals for this run:");
  console.log("  pi.session.count      1");
  console.log("  pi.prompt.count       3");
  console.log("  pi.tool_call.count    6   (3 Read, 3 Bash)");
  console.log("  pi.tool_result.count  6   (5 success, 1 failure)");
  console.log("  pi.skill.invocation.count 2   (direct code-review + model-loaded find-skills)");
  console.log("  pi.turn.count         3");
  console.log("  pi.token.usage        input=3600 output=1020 cache_read=24000 cache_write=1500");
  console.log("  pi.cost.usage         ~0.093 total");
  console.log("\nCheck the result with: npm run dev:metrics");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
