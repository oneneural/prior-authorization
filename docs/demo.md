# Offline demo

This walkthrough runs the complete offline loop on synthetic data: a populated
queue, a missing-document gap, a neutral request with local approval, a
simulated receipt, a fixture reply, reassessment, source inspection and
administrative packet acceptance, plus the separately labelled recorded agent.
No model key, external message or payer request is involved. It is a
demonstration, not production software, and the outcome is an administrative
packet for qualified human review: never an authorization, a medical necessity
decision or a payment.

## Start

From a clean clone with Docker, Compose and a POSIX shell, and no retained
deployment using the `prior-authorization` project:

```sh
cp .env.example .env
scripts/init-secrets.sh
```

Set `AGENT_GRAPH_PROVIDER=recorded` in `.env` to select the scripted investigation
explicitly; the default is `off`. Then start:

```sh
PA_BUILD_REVISION="$(git rev-parse HEAD)" docker compose up --build -d --wait
```

Open `http://127.0.0.1:3105/`. On start the API seeds seven synthetic cases
idempotently: `case-f01`, `case-f02`, `case-f08a`, `case-f23` and `case-f28a`
from the fixtures, plus two derived cases, `case-f02-loop` and
`case-agent-demo`, which are F01's subject with its order and receipt withheld
(the SPEC F02 missing-order scenario). A restart never changes an existing case.

## Walkthrough in the browser

1. Sign in as **fixture operator**. The queue shows each case's administrative
   state, outstanding issues and clinical questions, with no approval
   likelihood.
2. Open `case-f02-loop`. It needs information: R03 reports the finalized order
   as not supplied. Each fact links to its source at the exact locator.
3. Open **Request**, prepare the neutral draft for R03 and approve it locally.
   The worker records one local receipt: "simulated, nothing transmitted".
4. Record the fixture response (the archived finalized order). The case is
   reassessed on revision 2, becomes ready for administrative review and the
   request closes. If a reply does not resolve the rule, **Close unresolved
   request** allows a follow-up draft.
5. Sign out and sign in as **fixture administrative reviewer** (not a clinical
   credential). Open **Packet**: "Administrative review only. No payer
   submission." Accept it for administrative review; clinical review,
   authorization and payment stay undecided.
6. As the operator, open `case-agent-demo` and start the **recorded agent
   investigation (scripted fixture)**. It replays a recorded model transcript
   through the real LangGraph graph and tools; no model is called. It stops for
   human review with one valid fact, one valid request proposal and two
   rejected candidates (an invented citation and one below the confidence
   floor). As the reviewer, accept or reject the valid proposals. An operator
   can **Cancel this run** if it is ever stranded in flight.
7. Optionally cancel another case: cancellation is terminal and a late reply
   becomes audit-only.

## Scripted smoke

`scripts/demo/smoke.sh` runs the same loop through the web BFF against a
disposable deployment, with its own throwaway secrets and no model key.

It needs Node **24.22.0**, Docker with Compose, and POSIX utilities including
curl, netcat (`nc`), `od`, `tar` and `shasum`. It drives HTTP requests through the
BFF, not an actual browser. The wrapper supplies `PA_DEMO_ORIGIN` from `--port`;
for direct use, `walkthrough.mjs` reads that exported variable and defaults to
`http://127.0.0.1:3105` only when it is unset. See the
[configuration reference](operations.md#configuration-reference).

```sh
scripts/demo/smoke.sh                       # project prior-authorization-smoke on 127.0.0.1:3105
scripts/demo/smoke.sh --project NAME --port 3127   # when 3105 or the name is taken
```

It refuses an existing project, existing volumes or a busy port. It drives the
walkthrough above (and a live-mode request, which is refused with
`capability_disabled`), stops and starts the whole deployment and verifies that
states, packet and source hashes, the one receipt and the waiting agent run are
unchanged, backs up the database and evidence, removes the deployment with
`down -v`, restores into fresh volumes as `NAME-restore`, verifies again and
completes the pending agent run from its restored checkpoint. It removes both
projects and their volumes on exit (`--keep` leaves the restored one running).

## Reset and evaluation

- Reset a disposable demo: `docker compose -p prior-authorization down -v`, then
  `docker compose up -d --wait`. This deletes every case, session, request and
  checkpoint; the seed recreates the seven cases on start.
- Backup and restore: [operations](operations.md#backup-and-restore).
- Evaluation (repository checkout with Node and pnpm, no container):
  `pnpm test:evals` runs the rules assessment against the frozen oracles and
  reports false-ready, then compares `rules_only` with scripted LangGraph runs
  over the same cases. Every graph result is labelled scripted with no provider
  call. The separate, paid `pnpm test:evals:live` runs one bounded live Claude
  evaluation ([development](development.md#live-claude-evaluation)); its
  measured results are summarized under
  [evaluation evidence](#evaluation-evidence-and-technical-scope).

## Evaluation evidence and technical scope

The [2026-10-21 full report](../evals/reports/live-claude/2026-10-21-full.md)
records `pnpm test:evals:live` with `claude-opus-5-5` at medium effort over 22
synthetic cases:
held-out H01 to H09, adversarial F17a, F17b, F18a, F18d and F21a, and the frozen
v2 snapshots F01, F02, F08a, F09a, F13x3, F16a, F23 and F26a. All 22 runs
finished within their limits in 128 provider calls, with 0 refusals,
truncations, API errors, invalid outputs or tool inputs, and 0 prohibited tool
attempts or executions. Issue precision and recall were each 49/49, false-ready
was 0/13 blocked cases, and 223/223 accepted fact proposals were source-supported
and matched deterministic extraction. The gate accepted 4/6 document requests,
rejecting two as not applicable. Full-run cost was USD 1.8407536; including the
one-case, five-call smoke, cost was USD 1.9394876. Median live case latency was
33,718 ms, compared with about 2 ms for rules.

Issue findings and readiness remain deterministic, so the equal issue scores
are inherited from the rules. Scripted runs exercise invented citations,
malformed proposals and prohibited tool attempts; on the adversarial cases the
live model made none of those attempts, and the report lists the differences.
The live evaluator uses a port that mirrors API validation, and the request
offers only the allowlisted tools. The
[contribution report](../evals/reports/contribution/2026-10-24-baseline.md)
records a separate rules-only regression baseline and evaluator-only fakes. The
cohorts are small, synthetic and share one authoring lineage.

Packaged graph modes are `off`, `recorded` and explicitly configured `live`. This
demo runs with live mode off, so its agent is the recorded fixture. Offline
fake-provider checks exercise the live accounting and worker boundaries; the
live overlay and accounting requirements are described in
[operations](operations.md#live-accounting).

Connector operations are local synthetic reads and simulated request receipts
labelled `scripted_fixture`. EHR and payer connectivity, external messages,
real patient data and FHIR/DTR/PAS exchanges are outside the implemented scope.
Image-only extraction and arbitrary uploads are unsupported. Recorded packaging
observations use macOS arm64 with Docker Desktop, and the smoke drives HTTP
through the BFF rather than an actual browser. The lab produces administrative
packets for human review and makes no clinical, payer or production claim.
