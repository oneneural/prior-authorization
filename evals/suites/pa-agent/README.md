# Agent comparison suite (pa-agent)

Evaluator-owned inputs and expectations for the comparison of rules-only
and scripted LangGraph runs. `pnpm test:evals` runs it through
`evals/src/agent-comparison.eval.ts`. Runtime code never reads this directory.

| Path | Contents |
| --- | --- |
| `fixtures/` | Original synthetic inputs in the version 2 fixture layout: held-out mutations `H01` to `H09` and adversarial inputs `F17a`, `F17b` and `F21a` |
| `expectations/` | One `pa.agent-expectation.v1` file per case: pinned fixture manifest, provider, expected state and issues, and expected graph behavior |
| `responses/` | Evaluator-only scripted provider turns in the runtime recording format. They are not runtime recordings and contain no expected outcome |

## Authoring

- Each fixture mutates one frozen `policy-v2` fixture. Held-out mutations change
  layout, document sequence, identity, dates or irrelevant text without changing
  the underlying policy outcome.
- Expected states and issues were written from the SPEC fixture rows, the base
  fixture's frozen oracle and the gate rules, before running the comparison. None
  was copied from implementation output. The `authoringNote` in each file states
  the reasoning.
- An issue is `ruleId:status` for every finding that is neither `pass` nor
  `not_applicable`.
- Every graph result is scripted, with no provider call. Actual-provider quality,
  latency and cost are unmeasured.

## Limitations

- Fixtures, expectations and scripted responses share one synthetic authoring
  lineage and have no independent clinical or payer review.
- Image-only documents are not representable: the document contract admits only
  JSON and `text/plain`. Case `F18d` uses the frozen `F08x4` text/plain note.
- The evaluator's tool port mirrors the API's proposal checks; it is not the API.
