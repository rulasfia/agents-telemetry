# Minor improvements

**Severity:** Low — none of these break the dashboard today; each is a small
robustness or hygiene win.

## 1. `prompt.length` attribute is unbounded cardinality

**Files:** `pi/src/telemetry.ts` (`recordUserPrompt`), `claude/src/bridge.ts`
(UserPromptSubmit), README metrics table.

Both emitters attach the raw character count to `pi.prompt.count`. Every distinct
length is a new Prometheus series, multiplied by `session.id`. Nothing on the
dashboard uses it.

**Fix:** bucket it (`0-100`, `100-1k`, `1k-10k`, `10k+`) or drop the attribute
entirely. Dropping is simplest; bucketing preserves a rough "how long are prompts"
signal. Apply identically in both emitters and update the README table.

## 2. `session.id` drop advice isn't reflected in shipped collector configs

**Files:** `deploy/otel-collector.yaml` (primary), README.

The README warns `session.id` is high-cardinality and says to drop it in the
collector "for long-lived aggregate metrics", but neither `deploy/` nor `demo/`
does so. `demo/` should keep it (the dashboard's Session dropdown needs it), but
`deploy/` is the long-lived setup the warning is about.

**Fix:** either add a commented-out `transform`/`attributes` processor block to
`deploy/otel-collector.yaml` showing exactly how to drop it, or enable it and note
that the Session dashboard variable then only applies to demo setups. At minimum,
make the README point at a concrete config snippet.

## 3. State-file race between async UserPromptSubmit and sync Stop

**Files:** `claude/src/bridge.ts`.

`UserPromptSubmit` runs `async: true` and rewrites the whole state file
(read-modify-write, no lock). On a very fast turn its write can land **after**
`Stop`'s, regressing `transcriptOffset` (→ tokens double-counted on the next Stop)
or losing the turn timing. The equivalent race for tool events is already handled
with `persist = false`.

**Fix:** on UserPromptSubmit, re-read the state file immediately before writing and
patch only `turnStartTime` into the freshly-read state (merge-on-write). Window is
small; low priority, but the fix is a few lines.

## 4. Verify `duration_ms` exists on PostToolUse hook payloads

**Files:** `claude/src/bridge.ts` (~line 266).

The bridge reads `event.duration_ms` to record `pi.tool.duration`. The
`isFinite` guard means nothing breaks if the field is absent — but then the
tool-duration panels silently contain pi-only data.

**Action:** confirm against current Claude Code hook docs/payloads whether
PostToolUse carries a duration field (and its exact name/unit). If it doesn't,
either derive duration from a PreToolUse timestamp keyed by `tool_use_id`
(per-tool-call key avoids the parallel-tool race noted in the code) or document
that tool duration is pi-only.

## 5. Tool metrics semantics differ slightly between sources

**Files:** documentation only.

In the Claude bridge, `pi.tool_call.count` is emitted at PostToolUse, so calls that
never complete aren't counted and call count == result count by construction. In pi,
calls are counted at `tool_execution_start`, so the two counters can diverge. Not
worth changing (PreToolUse hooks would add latency); worth a one-line note in the
README metrics table so nobody chases a phantom discrepancy.
