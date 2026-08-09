/**
 * Metric attributes shared by both emitters.
 *
 * Like `config.ts`, this is shared by the pi, Claude Code, and OpenCode
 * emitters so attribute conventions stay aligned across harnesses.
 */

/** Fixed set of buckets, so this attribute can never grow the series count. */
export type PromptLengthBucket = "0-100" | "100-1k" | "1k-10k" | "10k+";

/** Stable two-letter prefixes used to distinguish harness-specific tools. */
export type ToolHarness = "pi" | "cc" | "oc";

/**
 * Build a consistent `tool.name` from a harness and its native tool name.
 *
 * Harnesses expose equivalent tools with different casing and naming styles
 * (`Read`, `read`, `ToolSearch`, MCP names, and so on). Snake-casing and
 * prefixing them produces predictable labels such as `cc_read`, `pi_read`,
 * and `oc_read` while retaining which harness invoked the tool.
 */
export function normalizeToolName(harness: ToolHarness, toolName: string) {
  const normalized = toolName
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return `${harness}_${normalized || "unknown"}`;
}

/**
 * Bucket a prompt's character count.
 *
 * The raw count was previously attached to `pi.prompt.count`, which made every
 * distinct prompt length its own Prometheus series — multiplied by session.id,
 * and unbounded over time. Four buckets keep the rough "how long are prompts"
 * signal at a fixed cardinality. Boundaries are lower-inclusive.
 */
export function promptLengthBucket(length: number): PromptLengthBucket {
  if (!Number.isFinite(length) || length < 100) return "0-100";
  if (length < 1_000) return "100-1k";
  if (length < 10_000) return "1k-10k";
  return "10k+";
}
