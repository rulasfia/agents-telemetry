import { describe, it, expect } from "vitest";
import { normalizeToolName, promptLengthBucket } from "./attributes.js";

describe("normalizeToolName", () => {
  it("prefixes equivalent harness tools consistently", () => {
    expect(normalizeToolName("cc", "Read")).toBe("cc_read");
    expect(normalizeToolName("pi", "read")).toBe("pi_read");
    expect(normalizeToolName("oc", "READ")).toBe("oc_read");
  });

  it("normalizes camel case and punctuation to snake case", () => {
    expect(normalizeToolName("cc", "ToolSearch")).toBe("cc_tool_search");
    expect(normalizeToolName("cc", "mcp__chrome-devtools__take_screenshot"))
      .toBe("cc_mcp_chrome_devtools_take_screenshot");
  });

  it("uses an explicit fallback for blank or punctuation-only names", () => {
    expect(normalizeToolName("oc", "  ")).toBe("oc_unknown");
    expect(normalizeToolName("pi", "---")).toBe("pi_unknown");
  });
});

describe("promptLengthBucket", () => {
  it("buckets by magnitude with lower-inclusive boundaries", () => {
    expect(promptLengthBucket(0)).toBe("0-100");
    expect(promptLengthBucket(99)).toBe("0-100");
    expect(promptLengthBucket(100)).toBe("100-1k");
    expect(promptLengthBucket(999)).toBe("100-1k");
    expect(promptLengthBucket(1_000)).toBe("1k-10k");
    expect(promptLengthBucket(9_999)).toBe("1k-10k");
    expect(promptLengthBucket(10_000)).toBe("10k+");
    expect(promptLengthBucket(5_000_000)).toBe("10k+");
  });

  it("keeps cardinality fixed no matter the input", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 20_000; n += 7) seen.add(promptLengthBucket(n));
    expect(seen.size).toBe(4);
  });

  it("folds a nonsensical length into the default bucket", () => {
    // String.length can't actually produce these; the guard exists so a bad
    // value can never escape as its own label.
    expect(promptLengthBucket(-1)).toBe("0-100");
    expect(promptLengthBucket(NaN)).toBe("0-100");
    expect(promptLengthBucket(Infinity)).toBe("0-100");
  });
});
