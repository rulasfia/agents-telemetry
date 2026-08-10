#!/usr/bin/env node
/**
 * Replay a realistic Claude Code hook sequence through the compiled bridge.
 *
 *   npm run dev:replay
 *   ATEL_ENDPOINT=http://localhost:4418 npm run dev:replay
 *
 * Claude Code spawns one bridge process per hook event, so this does the same
 * rather than calling the handler in-process — process-boundary bugs (state
 * persistence, delta temporality, flush-before-exit) only show up this way.
 *
 * HOME is redirected to a scratch directory so the replay's session state in
 * ~/.pi/otlp-claude never mixes with state from real Claude Code sessions.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = join(repoRoot, "claude", "dist", "bridge.cjs");

const endpoint = process.env.ATEL_ENDPOINT ?? "http://localhost:4418";
const sessionId = process.env.DEV_SESSION_ID ?? `dev-${Date.now()}`;
const keepState = process.env.DEV_KEEP_STATE === "1";

const scratch = mkdtempSync(join(tmpdir(), "pi-otlp-dev-"));
const transcript = join(scratch, "transcript.jsonl");
mkdirSync(join(scratch, ".pi"), { recursive: true });
writeFileSync(transcript, "");

/** Append an assistant message so the Stop handler has token usage to read. */
function addTranscriptTurn({ input, output, cacheRead, cacheWrite, model }) {
  appendFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      message: {
        model,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheWrite,
        },
      },
    }) + "\n",
  );
}

function send(event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      env: {
        ...process.env,
        HOME: scratch,
        ATEL_CLAUDE_CODE: "1",
        ATEL_ENDPOINT: endpoint,
        ATEL_DEBUG: process.env.ATEL_DEBUG ?? "0",
      },
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const name = event.hook_event_name;
      if (code === 0) {
        console.log(`  ✓ ${name}`);
        resolve();
      } else {
        reject(new Error(`${name} exited with code ${code}`));
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

const base = { session_id: sessionId, transcript_path: transcript };

const sequence = [
  {
    ...base,
    hook_event_name: "SessionStart",
    source: "startup",
    model: { provider: "anthropic", id: "claude-opus-5" },
  },
  { ...base, hook_event_name: "UserPromptSubmit", prompt: "add a dev replay harness" },
  {
    ...base,
    hook_event_name: "UserPromptExpansion",
    expansion_type: "slash_command",
    command_name: "code-review",
  },
  {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Skill",
    tool_input: { skill: "find-skills" },
    duration_ms: 5,
  },
  {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    duration_ms: 42,
  },
  {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    duration_ms: 118,
  },
  // Exercises the success=false branch of pi.tool_result.count.
  {
    ...base,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    duration_ms: 2500,
  },
  { ...base, hook_event_name: "Stop" },
  // A second turn proves the transcript offset advances instead of
  // re-counting the tokens already reported by the first Stop.
  { ...base, hook_event_name: "UserPromptSubmit", prompt: "now document it" },
  { ...base, hook_event_name: "Stop" },

  // Compaction raises SessionStart again, mid-session, under the same session
  // id and on the same append-only transcript. It must neither re-count the
  // two turns above nor increment pi.session.count.
  {
    ...base,
    hook_event_name: "SessionStart",
    source: "compact",
    model: { provider: "anthropic", id: "claude-opus-5" },
  },
  { ...base, hook_event_name: "UserPromptSubmit", prompt: "keep going" },
  { ...base, hook_event_name: "Stop" },
  { ...base, hook_event_name: "SessionEnd" },

  // `claude --resume` reopens a transcript that already holds every turn
  // above. This is a genuinely new session, so it counts — but its first Stop
  // must report one turn's tokens, not the whole file's.
  {
    ...base,
    hook_event_name: "SessionStart",
    source: "resume",
    model: { provider: "anthropic", id: "claude-opus-5" },
  },
  { ...base, hook_event_name: "UserPromptSubmit", prompt: "one more thing" },
  { ...base, hook_event_name: "Stop" },
  { ...base, hook_event_name: "SessionEnd" },
];

console.log(`Replaying ${sequence.length} hook events`);
console.log(`  endpoint:   ${endpoint}`);
console.log(`  session.id: ${sessionId}`);
console.log(`  scratch:    ${scratch}\n`);

let failed = false;
try {
  for (const event of sequence) {
    // Each Stop reads the transcript delta, so new usage has to land before it.
    if (event.hook_event_name === "Stop") {
      addTranscriptTurn({
        input: 1200,
        output: 340,
        cacheRead: 8000,
        cacheWrite: 500,
        model: "claude-opus-5",
      });
    }
    await send(event);
  }
  console.log("\nExpected totals for this run:");
  console.log("  pi.session.count      2   (startup + resume; compact is not a new session)");
  console.log("  pi.prompt.count       4");
  console.log("  pi.tool_call.count    4   (Skill, Read, Edit, Bash)");
  console.log("  pi.tool_result.count  4   (3 success, 1 failure)");
  console.log("  pi.skill.invocation.count 2   (direct code-review + agent-loaded find-skills)");
  console.log("  pi.turn.count         4");
  console.log("  pi.token.usage        input=4800 output=1360 cache_read=32000 cache_write=2000");
  console.log("  pi.session.duration   2 histogram observations");
  console.log("\n  Token totals are 4 turns' worth. Anything higher means a");
  console.log("  SessionStart rewound the transcript offset and re-counted.");
  console.log("\nCheck the result with:");
  console.log("  docker compose -f stack/docker-compose.dev.yml logs -f otel-collector");
  console.log("  npm run dev:metrics");
} catch (err) {
  failed = true;
  console.error(`\nReplay failed: ${err.message}`);
  console.error(`Is the bridge built? Run: npm run build:claude`);
} finally {
  if (keepState) console.log(`\nScratch kept at ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
