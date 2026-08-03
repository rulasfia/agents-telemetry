# Dashboard fixes

**Severity:** High — the dashboard is the deliverable of the whole project, and three
of its controls/panels are broken or misleading.
**Files:** `grafana/pi-otlp-dashboard.json`

## Problem 1: template variables are dead

The dashboard defines Session / Tool / Provider dropdowns (`$session_id`,
`$tool_name`, `$provider`), but **zero panel queries reference them** — selecting a
value changes nothing. Verified with a grep over `"expr"` fields: no `$session_id`,
`$tool_name`, or `$provider` occurrences.

### Fix

Wire the variables into the panel queries, e.g.:

```promql
round(sum(increase(pi_turn_count_total{session_id=~"$session_id", provider=~"$provider"}[$__range])))
```

Tool-scoped panels additionally filter `tool_name=~"$tool_name"`. Alternatively,
delete the variables — but wiring them is the better outcome since the `allValue`
regexes (`.*`) are already set up for it.

## Problem 2: no way to tell pi from Claude Code

Both emitters land in the same panels (good — that's the goal), but nothing surfaces
which source the data came from. The `service_name` label already exists on every
series: the pi extension reports `service.name=pi-coding-agent`, the Claude bridge
reports `pi-otlp-claude`, and both collector configs enable
`resource_to_telemetry_conversion`.

### Fix

- Add a `service_name` template variable labelled **Source** (query:
  `label_values(pi_session_count_total, service_name)`, include-all, multi).
- Filter panels on it like the other variables.
- Add one or two `sum by (service_name)` breakdown panels (e.g. "Tokens by Source",
  "Turns by Source") to the Overview or Provider row.
- Optionally do the same for `device_name` (emitted when `PI_OTLP_DEVICE_NAME` is
  set) for multi-device setups.

## Problem 3: instant-vector panels undercount

Two panels use instant vectors over series that expire:

- **Total Sessions:** `count(pi_session_count_total)` counts series currently exposed
  by the collector's Prometheus exporter. Its default `metric_expiration` is 5
  minutes, and the Claude bridge only exports when hooks fire — an idle session's
  series expires and drops out of the count.
- **Avg Cost per Session:** `sum(pi_cost_usage_USD_total) / count(pi_session_count_total)`
  — same flaw on both sides of the division.

### Fix

Use range-based increase like the neighbouring panels:

```promql
# Total Sessions
round(sum(increase(pi_session_count_total[$__range])))

# Avg Cost per Session
sum(increase(pi_cost_usage_USD_total[$__range]))
  / round(sum(increase(pi_session_count_total[$__range])))
```

## Acceptance

- Changing any dropdown visibly filters every panel.
- A "Source" dropdown distinguishes `pi-coding-agent` from `pi-otlp-claude`.
- Total Sessions matches the number of sessions started within the selected time
  range, including sessions idle longer than 5 minutes.
