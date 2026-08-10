# Telemetry reference

This is the durable reference for the metrics emitted by the pi, Claude Code, and
OpenCode integrations. Historical implementation findings live in
[`plans/`](./plans/).

## Harnesses and services

The integrations emit the same `pi.*` metric names. Use `service_name` to split
or combine them:

| Harness | `service_name` | Metric temporality |
|---|---|---|
| pi | `pi-coding-agent` | cumulative, from the long-lived extension process |
| Claude Code | `pi-otlp-claude` | delta, from one hook process per event; the collector converts it to cumulative |
| OpenCode | `pi-otlp-opencode` | cumulative, from the long-lived plugin process |

All metric data points have `session.id`, `provider`, and `model` attributes.
In Prometheus these become `session_id`, `provider`, and `model` labels.

## Tool telemetry

| Metric | Meaning | Additional attributes |
|---|---|---|
| `pi.tool_call.count` | Tool invocation | `tool.name` |
| `pi.tool_result.count` | Tool completion | `tool.name`, `success` |
| `pi.tool.duration` | Tool execution time in seconds | `tool.name`, `success` |

`tool.name` is a stable, harness-prefixed, lowercase snake-case label. The shared
normalizer turns equivalent native names into distinct labels, for example:

| Native name | pi | Claude Code | OpenCode |
|---|---|---|---|
| `Read` / `read` | `pi_read` | `cc_read` | `oc_read` |
| `ToolSearch` | `pi_tool_search` | `cc_tool_search` | `oc_tool_search` |
| `mcp__chrome-devtools__take_screenshot` | `pi_mcp_chrome_devtools_take_screenshot` | `cc_mcp_chrome_devtools_take_screenshot` | `oc_mcp_chrome_devtools_take_screenshot` |

The prefix is deliberately retained even when two harnesses expose the same
native capability. This prevents one Prometheus series from combining different
implementations.

Tool call/result timing is intentionally harness-specific:

- **pi** records calls at `tool_execution_start`, then records results and
  durations at `tool_execution_end`.
- **Claude Code** records both call and result counters after `PostToolUse` or
  `PostToolUseFailure`, because the bridge has no `PreToolUse` hook. A tool that
  never reaches a post-tool event is not counted.
- **OpenCode** records calls at `session.tool.input.started` and results at its
  success or failure event.

## Skill telemetry

`pi.skill.invocation.count` records when a skill is loaded or directly invoked.
It has one additional attribute:

| OTLP attribute | Prometheus label | Example |
|---|---|---|
| `skill.name` | `skill_name` | `pi_code_review`, `cc_find_skills`, `oc_git_release` |

Skill names use the **same normalizer and harness codes as tools**: `pi_`,
`cc_`, and `oc_`. Names are lowercased, camel case and punctuation become
underscores, and an empty name becomes `<harness>_unknown`.

### How each harness detects an invocation

| Harness | Detection |
|---|---|
| pi | A direct `/skill:<name>` command is counted from the raw input event. A model-selected directory skill is counted when pi reads its `<skill>/SKILL.md` entrypoint. |
| Claude Code | A direct skill/custom-command expansion is counted from `UserPromptExpansion`. A model-selected skill is counted when the `Skill` tool completes; its `tool_input.skill` identifies the skill. |
| OpenCode | The native `session.skill.activated` event supplies the exact skill ID and is counted directly. |

A skill is instructions that may remain in conversation context across later
turns; it is not a bounded execution. Therefore this package intentionally does
not expose a skill duration or a skill success metric. The counter measures an
invocation/load, not whether every instruction was followed.

## Dashboard and PromQL

The provisioned Grafana dashboard includes a **Skill** variable and a **Skill
Activity** row with:

- Total Skill Invocations
- Skill Invocations by Type
- Skill Invocation Distribution

The Skill variable filters by `skill_name`; it is independent of the Tool
variable (`tool_name`).

Every counter has a `session_id` series. A session series begins with its full
contribution and normally stays flat afterwards, so Prometheus `increase()`
does not count the first sample. Use `max_over_time` for totals over a selected
range, and reserve `increase()` for activity over time:

```promql
# Total skill invocations in the selected range.
sum(max_over_time(pi_skill_invocation_count_total[$__range]))

# Activity by skill across scrape intervals.
sum by (skill_name) (
  increase(pi_skill_invocation_count_total[$__rate_interval])
)
```

Apply the dashboard's `service_name`, `device_name`, `session_id`, `provider`,
`model`, and `skill_name` filters when adapting these queries.
