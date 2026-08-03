# Dashboard fixes

> **RESOLVED**, with one correction to the plan itself: the fix proposed for
> Problem 3 was wrong and would have made every total read zero. See
> [Problem 3](#problem-3-instant-vector-panels-undercount) for what was actually
> wrong and what shipped.

**Severity:** High — the dashboard is the deliverable of the whole project, and three
of its controls/panels are broken or misleading.
**Files:** `stack/grafana/dashboards/pi-otlp-dashboard.json`

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
- Optionally do the same for `device_name` (emitted when `ATEL_DEVICE_NAME` is
  set) for multi-device setups.

## Problem 3: instant-vector panels undercount

Two panels use instant vectors over series that expire:

- **Total Sessions:** `count(pi_session_count_total)` counts series currently exposed
  by the collector's Prometheus exporter. Its default `metric_expiration` is 5
  minutes, and the Claude bridge only exports when hooks fire — an idle session's
  series expires and drops out of the count.
- **Avg Cost per Session:** `sum(pi_cost_usage_USD_total) / count(pi_session_count_total)`
  — same flaw on both sides of the division.

### Fix — as proposed, and why it was wrong

The plan originally proposed copying the neighbouring panels:

```promql
round(sum(increase(pi_session_count_total[$__range])))     # WRONG: always 0
```

Measured against a replay with known totals, that returns **0** — and so did the
neighbouring panels it was copying. `increase()` is the wrong function for this
data shape, which makes the real defect much wider than the two panels named
above.

Every counter carries a `session_id` label, so each session gets its own series.
That series is *born carrying the session's entire contribution* and then never
changes: a short session's nine hook events all land inside one 15s scrape
interval, so Prometheus never observes a climb. A flat series has no increase,
and Prometheus does not treat a series' first sample as a rise from zero.
`pi_session_count_total` is worse still — it is 1 for the life of the series by
definition, so its increase is *always* 0 no matter how long the session runs.

Measured, over a range containing four known sessions:

| query | result | truth |
|---|---|---|
| `count(pi_session_count_total)` (original) | 4 | 4, but silently drops sessions the collector expired after 5m |
| `sum(increase(pi_session_count_total[1h]))` (proposed) | **0** | 4 |
| `sum(max_over_time(pi_session_count_total[1h]))` (shipped) | 4 | 4 |
| `sum(increase(pi_turn_count_total[1h]))` | **0** | 10 |
| `sum(max_over_time(pi_turn_count_total[1h]))` | 10 | 10 |

### Fix — what shipped

Every **range total** — anything aggregating over `[$__range]` — moved from
`increase()` to `max_over_time()`, which takes each session's final value inside
the range:

```promql
round(sum(max_over_time(pi_session_count_total{...}[$__range])))

sum(max_over_time(pi_cost_usage_USD_total{...}[$__range]))
  / round(sum(max_over_time(pi_session_count_total{...}[$__range])))
```

Trade-off: a session that started before the range begins now contributes its
whole total rather than just the part inside the range. That is the better error
— the alternative was reporting zero.

The **activity-over-time** panels (`[$__rate_interval]`) deliberately keep
`increase()`/`rate()`. They plot when work happened rather than totals, and they
do work in production, where a session's counters climb across many scrapes.
Verified with a session paced at 25s per turn: Prometheus observed `1→2→3→4` and
the panels reported ~3.4 turns — `increase()` missing the birth value is standard
Prometheus behaviour, not a defect. Against the compressed dev replay these
panels read zero, which is an artefact of the replay, not the dashboard.

## Acceptance

- Changing any dropdown visibly filters every panel. ✅ all six variables are
  referenced by all 55 targets (`tool_name` on the 14 `pi_tool_*` targets).
- A "Source" dropdown distinguishes `pi-coding-agent` from `pi-otlp-claude`. ✅
  plus "Tokens by Source" / "Turns by Source" panels.
- Total Sessions matches the number of sessions started within the selected time
  range, including sessions idle longer than 5 minutes. ✅ verified at 4/4.
