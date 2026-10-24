# Live Claude evaluation reports

Committed records of `pnpm test:evals:live` runs, labelled
`live_claude`. Each run writes `<UTC date>-<label>.json`
(`pa.live-eval-report.v1`) and a Markdown summary. They hold model, effort, price
snapshot, revision, caps, ledger totals, per-case gate results, sanitized trace
steps (names, outcomes, hashes and timings) and per-call outcomes, usage, costs
and latency. They hold no document bodies, model text or reasoning.

| Report | Cases | Calls | Cost (USD) | Notes |
| --- | --- | --- | --- | --- |
| [2026-10-21-smoke-f01](2026-10-21-smoke-f01.md) | F01 | 5 | 0.0987 | Single-case smoke used to project the full run's cost |
| [2026-10-21-full](2026-10-21-full.md) | 22 | 128 | 1.8408 | The one full run of the critical subset |

Both runs used revisions whose prompt and tool definitions were fixed before
the first live call; nothing was tuned between runs. See
[development](../../../docs/development.md#live-claude-evaluation) for the
command and its budget enforcement.
