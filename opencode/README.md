# OpenCode V2 plugin

This is the OpenCode V2 port of agents-telemetry. It is a long-lived in-process
plugin: one `MeterProvider` is shared by the OpenCode service and exports
cumulative metrics on the configured interval.

Enable it with `ATEL_OPENCODE=1`, then add the package to an OpenCode V2 config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@rulasfia/agents-telemetry"]
}
```

For local development from this repository, use:

```json
{
  "plugins": ["./opencode/src/index.ts"]
}
```

The plugin uses the public V2 `ctx.event.subscribe()` API. Its event mapping is:

| OpenCode V2 event | Metrics |
|---|---|
| `session.created` / `session.deleted` | session count / session duration |
| `session.input.admitted` | prompt count |
| `session.execution.started` / terminal event | turn count / turn duration |
| `session.step.ended` | token usage |
| `session.tool.input.started` / terminal event | tool call, result, and duration |
| `session.model.selected` | provider and model labels for subsequent metrics |

OpenCode exposes a total cost per model step, but not the per-token-type cost
breakdown required by the existing `pi.cost.usage` metric. The plugin therefore
does not emit cost metrics rather than assigning the total to an incorrect type.

Use `opencode2 api get /api/plugin` to confirm `rulasfia.agents-telemetry` is
active. See the root [README](../README.md) for shared `ATEL_*` configuration.
