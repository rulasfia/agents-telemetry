/**
 * Metric attributes shared by both emitters.
 *
 * Like `config.ts`, this is imported by the pi extension and by the Claude Code
 * bridge, so the two sources label identical metrics identically. A value that
 * differs between them splits one Prometheus series in two.
 */

/** Fixed set of buckets, so this attribute can never grow the series count. */
export type PromptLengthBucket = "0-100" | "100-1k" | "1k-10k" | "10k+";

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
