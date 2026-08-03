# Resume/compact token double-count

**Severity:** High — silently inflates `pi.token.usage`, the headline metric.
**Files:** `claude/src/bridge.ts` (SessionStart handler, ~line 203)

## Problem

On `SessionStart` the bridge unconditionally resets the transcript read position:

```ts
state.sessionStartTime = now;
state.transcriptOffset = 0;
```

When a session is **resumed** (`claude --resume`/`--continue`) or restarts after
**compaction**, the transcript file already contains the full prior conversation.
With the offset reset to 0, the first `Stop` event runs `readTranscriptDelta` from
the beginning and sums usage from every earlier assistant message — tokens the
previous session (or pre-compact session) already reported. The totals on the
dashboard double.

The `SessionEnd` handler clears the state file, so the old offset is gone by the
time the resumed session starts; there is nothing to recover it from.

## Fix

`SessionStart` hook input includes a `source` field (`"startup"`, `"resume"`,
`"clear"`, `"compact"`) and `transcript_path`. Initialize the offset by source:

- `startup` / `clear`: fresh transcript → `transcriptOffset = 0` (current behavior).
- `resume` / `compact`: pre-existing content must not be re-counted →
  `transcriptOffset = statSync(transcript_path).size` (fall back to 0 if the file
  is missing or unreadable).

Open decision on `compact`: after auto-compaction mid-session, verify whether Claude
Code rewrites the same transcript file or starts a new one, and whether a
`SessionStart(source: "compact")` fires at all in that flow. If compaction rewrites
the file to a *smaller* size mid-session without a SessionStart, the existing
"offset > size → start over" guard in `readTranscriptDelta` already resets to 0 and
would re-count the compacted summary's usage — check what usage fields survive
compaction before deciding whether that needs its own guard.

Also decide whether `pi.session.count` should increment on `resume` — arguably a
resume is not a new session. Recommendation: still count it (each resume is a new
process/session-id and matches how the pi extension counts), but note it in the
README.

## Acceptance

- Unit test: `SessionStart` with `source: "resume"` and a transcript containing
  prior assistant usage → first `Stop` reports only the new turn's tokens.
- Manual: start a session, note token totals, exit, `claude --resume`, run one
  small turn — dashboard increase matches that turn, not the whole history.
