# Plans

Findings from the 2026-08-03 review of the dual-source (pi extension + Claude Code
plugin) OTLP setup. The goal — both emitters reporting the same `pi.*` metrics into
one Grafana dashboard — is architecturally sound and working; these plans cover the
issues found, ranked by severity.

| # | Plan | Severity | Area |
|---|------|----------|------|
| 1 | [Dashboard fixes](./01-dashboard-fixes.md) | High | `grafana/` |
| 2 | [Resume/compact token double-count](./02-resume-token-double-count.md) | High | `claude/` |
| 3 | [Shared-config exporter gap for pi](./03-shared-config-exporter-gap.md) | Medium | `src/config.ts` |
| 4 | [Sync hook stall on unreachable collector](./04-sync-hook-exporter-timeout.md) | Medium | `claude/` |
| 5 | [Minor improvements](./05-minor-improvements.md) | Low | various |

## Review verdict (context)

- Both emitters share metric names (`pi.*`), attributes, and `src/config.ts`; all
  dashboard queries `sum(...)` across series, so pi and Claude Code data genuinely
  merge into the same panels.
- The short-lived-hook-process problem is solved correctly: the Claude bridge exports
  **delta** temporality and the collector's `deltatocumulative` processor stitches
  the per-process contributions back into cumulative counters for Prometheus.
- Distinct `service.name` values (`pi-coding-agent` vs `pi-otlp-claude`) plus
  `resource_to_telemetry_conversion` mean the two sources never collide and remain
  distinguishable via the `service_name` label.
- 71/71 tests pass; `npm run build:claude` compiles clean.
