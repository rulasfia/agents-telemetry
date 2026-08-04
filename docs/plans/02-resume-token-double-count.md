# Resume/compact token double-count

> **RESOLVED**, with two corrections to the plan itself. The bug was real and
> worse than described — compaction, not resume, is the common trigger — but the
> plan's guess about how compaction rewrites the transcript was wrong, and it
> missed a fifth `source` value. See [What the plan got wrong](#what-the-plan-got-wrong).

**Severity:** High — silently inflated `pi.token.usage`, the headline metric.
**Files:** `claude/src/bridge.ts` (SessionStart handler), `claude/src/transcript.ts`

## Problem

On `SessionStart` the bridge unconditionally reset the transcript read position:

```ts
state.sessionStartTime = now;
state.transcriptOffset = 0;
```

Whenever the transcript already contains messages at SessionStart, the next `Stop`
ran `readTranscriptDelta` from byte 0 and re-summed usage that had already been
reported. The totals on the dashboard inflate.

## What the plan got wrong

Both open questions in the original plan were resolved by reading the Claude Code
2.1.221 bundle and a real compacted transcript on disk.

**1. Compaction appends; it does not rewrite or shrink the file.** The plan worried
that compaction might rewrite the transcript to a *smaller* size and trip the
"offset > size → start over" guard in `readTranscriptDelta`. It does not. A real
compacted session (`~/.claude/projects/.../e1b39b20-….jsonl`) shows the
`system`/`compact_boundary` marker at line 506 of 571, in the **same file**, under
the **same session id**, with the file continuing to grow past it. The compact
summary is written as a `type:"user"` entry, so `sumUsage` — which only counts
`type:"assistant"` — never sees its tokens either way.

This makes compaction the *worst* case rather than an edge case. `Sje("compact", …)`
fires SessionStart mid-session while the state file still exists and the offset is
already deep into the file; resetting to 0 re-counted the entire pre-compaction
session. Compaction happens in every long session, so this fired far more often
than an explicit `--resume`.

**2. There are five sources, not four.** The bundle calls the SessionStart hook
runner as `Sje("clear")`, `Sje("compact")`, and
`Sje(forkSession ? "fork" : "resume", …)` — so `fork` exists alongside the
documented `startup` / `clear` / `resume` / `compact`. A fork mints a **new**
session id (`sessionId: r.forkSession ? Dt() : …`) whose transcript is a copy of the
full prior conversation, so it hits the same bug with empty state and no `resume`
label to key off.

## Fix

Rather than the plan's per-source branch table, the shipped fix is a single rule
that is correct for all five sources and any future one:

```ts
state.transcriptOffset = startTranscript
  ? transcriptSize(startTranscript)
  : (state.transcriptOffset ?? 0);
```

Seek to end-of-file at every SessionStart. Whatever is already in the transcript has
either been counted by a previous session, been counted by this session before
compaction, or predates the bridge entirely — in none of those cases should it be
claimed as new usage. On `startup` the file is empty or absent, so this is still 0
and behavior is unchanged. A missing `transcript_path` falls back to the stored
offset rather than 0, which is the safe direction on resume.

`transcriptSize` is a new export in `transcript.ts` (statSync size, 0 on any error).

### `pi.session.count` on resume

The plan asked whether resume should count. With `compact` in the picture the answer
is forced: SessionStart fires mid-session on compaction under the same session id, so
counting it inflated `pi.session.count` and restarted the session clock, truncating
`pi.session.duration`. Shipped rule:

```ts
const isNewSession = source !== "compact";
if (isNewSession || state.sessionStartTime === undefined) {
  state.sessionStartTime = now;
}
```

Compaction is the only source that fires mid-session, so it alone inherits the
running clock and does not count; everything else is a new process and does both.
An unknown or absent `source` therefore falls through to the old behavior, which is
the safe direction.

**Do not additionally gate this on `state.sessionStartTime === undefined`** — an
earlier revision of this fix did, reasoning that surviving state meant the id was
already counted. That is wrong, and `pruneStaleState` explains why: `SessionEnd` is
not guaranteed to fire, so a crashed session's state file lingers for up to 7 days.
Resuming it then inherited a days-old `sessionStartTime`, and the eventual
`SessionEnd` recorded the whole gap — ~345,600 s for a four-day-old crash — as one
observation in the `pi.session.duration` histogram. Starting a fresh clock costs at
most one extra `pi.session.count` on the same session id, which is defensible
anyway: that really is a second `claude` process, and it matches how the pi
extension counts.

## Acceptance — met

- Unit tests: `transcriptSize` covers the missing/empty/resume/compact-offset cases
  in `claude/src/transcript.test.ts` (81 tests pass, up from 77).
- End-to-end: `scripts/dev-replay.mjs` gained a compaction phase and a resume phase
  in one 15-event sequence. Replayed against the dev stack, measured with
  `npm run dev:metrics`:

  | metric | pre-fix | post-fix | correct |
  |---|---|---|---|
  | `pi_token_usage_tokens_total{type="input"}` | 10800 | **4800** | 4800 |
  | `pi_token_usage_tokens_total{type="output"}` | 3060 | **1360** | 1360 |
  | `pi_token_usage_tokens_total{type="cache_read"}` | 72000 | **32000** | 32000 |
  | `pi_session_count_total` | 3 | **2** | 2 |

  A 2.25× overcount on tokens, from four turns of real usage.
