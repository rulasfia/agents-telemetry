import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readLastModel,
  readTranscriptDelta,
  sumUsage,
  transcriptSize,
} from "./transcript.js";
import { VERSION } from "./version.js";

function assistant(usage: Record<string, number>, model = "claude-sonnet-5") {
  return JSON.stringify({
    type: "assistant",
    message: { model, usage },
  });
}

describe("sumUsage", () => {
  it("sums every assistant message in the chunk", () => {
    const chunk = [
      assistant({
        input_tokens: 2,
        output_tokens: 100,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 30,
      }),
      assistant({
        input_tokens: 3,
        output_tokens: 50,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 0,
      }),
      "",
    ].join("\n");

    expect(sumUsage(chunk)).toEqual({
      input: 5,
      output: 150,
      cacheRead: 1200,
      cacheWrite: 30,
      model: "claude-sonnet-5",
    });
  });

  it("ignores user entries and assistant entries without usage", () => {
    const chunk = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { model: "m" } }),
      "",
    ].join("\n");

    expect(sumUsage(chunk)).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("skips unparseable lines without losing the rest", () => {
    const chunk = [
      "{not json",
      assistant({ input_tokens: 1, output_tokens: 2 }),
      "",
    ].join("\n");

    expect(sumUsage(chunk)).toMatchObject({ input: 1, output: 2 });
  });

  it("reports the most recent model", () => {
    const chunk = [
      assistant({ output_tokens: 1 }, "claude-sonnet-5"),
      assistant({ output_tokens: 1 }, "claude-opus-5"),
      "",
    ].join("\n");

    expect(sumUsage(chunk).model).toBe("claude-opus-5");
  });
});

describe("readTranscriptDelta", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-otlp-"));
    file = join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing for a missing transcript and keeps the offset", () => {
    expect(readTranscriptDelta(join(dir, "nope.jsonl"), 42)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      offset: 42,
    });
  });

  it("reads only what was appended since the last offset", () => {
    writeFileSync(file, assistant({ output_tokens: 10 }) + "\n");
    const first = readTranscriptDelta(file, 0);
    expect(first.output).toBe(10);

    appendFileSync(file, assistant({ output_tokens: 7 }) + "\n");
    const second = readTranscriptDelta(file, first.offset);
    expect(second.output).toBe(7);
    expect(second.offset).toBeGreaterThan(first.offset);
  });

  it("does not double-count when nothing was appended", () => {
    writeFileSync(file, assistant({ output_tokens: 10 }) + "\n");
    const first = readTranscriptDelta(file, 0);
    const second = readTranscriptDelta(file, first.offset);
    expect(second.output).toBe(0);
    expect(second.offset).toBe(first.offset);
  });

  it("leaves a partially written trailing line for the next read", () => {
    writeFileSync(file, assistant({ output_tokens: 10 }) + "\n");
    const complete = readTranscriptDelta(file, 0);

    appendFileSync(file, '{"type":"assistant","mess');
    const partial = readTranscriptDelta(file, complete.offset);
    expect(partial.output).toBe(0);
    expect(partial.offset).toBe(complete.offset);

    appendFileSync(file, 'age":{"usage":{"output_tokens":5}}}\n');
    expect(readTranscriptDelta(file, partial.offset).output).toBe(5);
  });

  it("restarts from zero when the transcript shrinks", () => {
    writeFileSync(file, assistant({ output_tokens: 10 }) + "\n");
    const stale = readTranscriptDelta(file, 0).offset + 1000;
    writeFileSync(file, assistant({ output_tokens: 3 }) + "\n");
    expect(readTranscriptDelta(file, stale).output).toBe(3);
  });
});

describe("transcriptSize", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-otlp-"));
    file = join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 for a missing or unnamed transcript", () => {
    expect(transcriptSize(undefined)).toBe(0);
    expect(transcriptSize(join(dir, "nope.jsonl"))).toBe(0);
  });

  it("returns 0 for the empty transcript a fresh session starts with", () => {
    writeFileSync(file, "");
    expect(transcriptSize(file)).toBe(0);
  });

  it("seeks past prior usage so a resumed session re-counts nothing", () => {
    // A session that already reported these tokens, then exited.
    writeFileSync(
      file,
      [
        assistant({ input_tokens: 100, output_tokens: 200 }),
        assistant({ input_tokens: 300, output_tokens: 400 }),
        "",
      ].join("\n"),
    );

    // `claude --resume` opens the same transcript; SessionStart seeks to EOF.
    const resumeOffset = transcriptSize(file);
    expect(readTranscriptDelta(file, resumeOffset).input).toBe(0);

    // Only the resumed session's own turn is reported.
    appendFileSync(file, assistant({ input_tokens: 7, output_tokens: 9 }) + "\n");
    const delta = readTranscriptDelta(file, resumeOffset);
    expect(delta.input).toBe(7);
    expect(delta.output).toBe(9);
  });

  it("matches the offset a mid-session read had already reached", () => {
    // Compaction fires SessionStart on the same, append-only transcript, so
    // seeking to EOF must not rewind the offset the session already holds.
    writeFileSync(file, assistant({ output_tokens: 10 }) + "\n");
    const afterStop = readTranscriptDelta(file, 0).offset;
    expect(transcriptSize(file)).toBe(afterStop);
  });
});

describe("readLastModel", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-otlp-"));
    file = join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a missing or empty transcript", () => {
    expect(readLastModel(join(dir, "nope.jsonl"))).toBeUndefined();
    writeFileSync(file, "");
    expect(readLastModel(file)).toBeUndefined();
  });

  it("returns the most recent assistant model", () => {
    writeFileSync(
      file,
      assistant({ output_tokens: 1 }, "claude-sonnet-5") +
        "\n" +
        assistant({ output_tokens: 1 }, "claude-opus-5") +
        "\n",
    );
    expect(readLastModel(file)).toBe("claude-opus-5");
  });

  it("finds the model in a transcript larger than the scan window", () => {
    const filler = JSON.stringify({ type: "user", text: "x".repeat(2000) });
    const lines = Array.from({ length: 60 }, () => filler);
    lines.push(assistant({ output_tokens: 1 }, "claude-opus-5"));
    writeFileSync(file, lines.join("\n") + "\n");
    expect(readLastModel(file)).toBe("claude-opus-5");
  });
});

describe("bridge version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
