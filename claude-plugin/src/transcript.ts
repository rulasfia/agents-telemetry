import { closeSync, openSync, readSync, statSync } from "fs";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Model id from the most recent assistant message, if any. */
  model?: string;
}

export interface TranscriptDelta extends UsageTotals {
  /** Byte offset to resume from on the next read. */
  offset: number;
}

const EMPTY: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Sum token usage across the assistant messages in a chunk of transcript JSONL.
 *
 * Claude Code's `Stop` hook payload carries `last_assistant_message` as a
 * plain string, so usage has to come from the transcript file instead. A turn
 * can contain many assistant messages (one per tool-calling round trip), so
 * every one in the chunk is summed rather than just the last.
 */
export function sumUsage(chunk: string): UsageTotals {
  const totals: UsageTotals = { ...EMPTY };

  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // Tolerate a torn or non-JSON line rather than losing the turn.
    }

    if (entry.type !== "assistant") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    totals.input += toCount(usage.input_tokens);
    totals.output += toCount(usage.output_tokens);
    totals.cacheRead += toCount(usage.cache_read_input_tokens);
    totals.cacheWrite += toCount(usage.cache_creation_input_tokens);

    const model = message?.model;
    if (typeof model === "string" && model) totals.model = model;
  }

  return totals;
}

/** Cap for the backwards model scan — a few transcript lines, not the session. */
const MODEL_SCAN_BYTES = 64 * 1024;

/**
 * Find the most recent assistant model id in the transcript.
 *
 * SessionStart carries no model field in practice, so early events would
 * otherwise be labelled model=unknown. By the time a tool completes, the
 * assistant message that requested it is already on disk. Only the tail is
 * read, and the caller is expected to skip this once the model is known.
 */
export function readLastModel(path: string): string | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - MODEL_SCAN_BYTES);
    if (size === start) return undefined;

    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    // Drop a leading partial line when the scan started mid-file.
    const chunk = buffer.subarray(0, bytesRead).toString("utf-8");
    return sumUsage(start > 0 ? chunk.slice(chunk.indexOf("\n") + 1) : chunk)
      .model;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do if the descriptor is already gone.
      }
    }
  }
}

/**
 * Read the transcript from `offset` to EOF and sum the usage it contains.
 *
 * Only whole lines are consumed; the returned offset points just past the last
 * newline so a partially-flushed trailing line is re-read next time. Reading
 * incrementally keeps this O(one turn) instead of O(whole session) per Stop.
 */
export function readTranscriptDelta(
  path: string,
  offset: number,
): TranscriptDelta {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    // A smaller file means it was truncated or replaced; start over.
    const start = offset > size || offset < 0 ? 0 : offset;
    if (size === start) return { ...EMPTY, offset: start };

    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);

    const lastNewline = buffer.lastIndexOf(0x0a, bytesRead - 1);
    if (lastNewline === -1) return { ...EMPTY, offset: start };

    const complete = buffer.subarray(0, lastNewline + 1);
    return {
      ...sumUsage(complete.toString("utf-8")),
      offset: start + complete.length,
    };
  } catch {
    // Missing or unreadable transcript: report nothing and keep the offset.
    return { ...EMPTY, offset };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do if the descriptor is already gone.
      }
    }
  }
}
