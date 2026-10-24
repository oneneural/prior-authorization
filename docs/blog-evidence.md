# Evidence for an article about administrative readiness

This is a source-backed planning document for an article about the synthetic
K0823 lab: a claim-to-evidence map and an outline, not article prose. Evidence
is specific to the revisions and cohorts named below.

## Problem and persona

The persona is an authorization coordinator at a fictional California durable
medical equipment supplier preparing an initial Medicare FFS K0823 request in a
Noridian Jurisdiction D context. The coordinator needs to distinguish missing
records from restricted or unreadable records, identify conflicting dates and
subjects, obtain existing finalized documents, and preserve the sources behind
an administrative packet. [The specification](../SPEC.md#problem-and-outcome)
defines the workflow and authority boundary.

The outcome is a packet accepted for administrative review. Clinical sufficiency,
payer authorization and payment require separate authority. The synthetic
workflow demonstrates engineering behavior within that boundary.

## Demonstrated story

[The demo](demo.md#walkthrough-in-the-browser) describes the reproducible story:

1. The fixture operator opens `case-f02-loop` and sees the missing finalized
   order, R03, and source-linked findings.
2. A fixed neutral request template asks for an existing finalized document.
   Local approval binds its content and current input revision.
3. The worker records a unique simulated receipt, with nothing transmitted.
4. The operator records `archive_f01`, an archived synthetic reply. Reassessment
   produces revision 2 and a packet ready for administrative review.
5. The fixture administrative reviewer accepts that exact packet. The clinical
   review requirement remains visible.
6. The recorded investigation on `case-agent-demo` offers a separate view of
   graph behavior: one valid fact and one valid request proposal reach human
   review, while an invented citation and a low-confidence candidate are rejected.
7. The smoke script checks that case and source hashes, a unique receipt and a
   waiting review checkpoint survive restart and a fresh-volume restore.

[The screenshots](images/README.md) show the operator queue, the case evidence,
the exact source view and the reviewer packet, with their capture state and
graph mode. [The local fixture adapter](connectors/local-fixtures.md) names the
operations and their `scripted_fixture` exchange label.

## Design tradeoffs

| Choice | Reason and consequence | Repository evidence |
| --- | --- | --- |
| One code, stage, state and supplier context | Keeps administrative applicability explicit; unsupported scope yields a hold | [SPEC scope](../SPEC.md#scope), [policy slice](policy-slice.md) |
| Immutable bytes, exact version/hash/locator references | A proposal can be checked against the source; a correction is a new version | [Architecture](../ARCHITECTURE.md#data-commands-and-recovery), `apps/api/src/agent/service.ts` |
| Deterministic rules own state | Agent proposals cannot resolve authority or clinical sufficiency; inherited issue scores must be separated from utility | `packages/domain/src/v2/assess.ts`, [live report](../evals/reports/live-claude/2026-10-21-full.md) |
| Strict structured JSON fixtures | Exact extraction and citations are inspectable; image-only extraction and arbitrary uploads are outside scope | [Policy formats](policy-slice.md#structured-source-bodies-and-locators), `packages/connectors/src/fixtures.ts` |
| Fixed neutral request templates and human approval | Requests obtain existing documents and stay separate from order authorship | `apps/api/src/workflow/templates.ts`, `apps/api/src/workflow/service.ts` |
| Atomic commands and PostgreSQL jobs | A rollback removes both the business change and its job; replay returns the recorded result | `packages/db/src/queue.ts`, `apps/api/test/enqueue.integration.test.ts` |
| One supervised app container with separate PostgreSQL | Simple local deployment and one failure boundary; shared UID/filesystem means process configuration is not sandbox isolation | [Operations](operations.md#credential-matrix), `compose.yaml` |
| Separate API-owned spend ledger | Database restore cannot reset model allowance; unknown usage remains held and uncertain accounting blocks admission | [ADR 0001](adr/0001-packaged-live-agent.md), `apps/api/src/accounting/ledger.ts` |
| Stop interrupted live investigations before review | In-process model conversation is distinct from graph checkpoints; review-only resume constructs no model client | [Architecture](../ARCHITECTURE.md#modes-live-evaluation-and-budget), `apps/worker/src/agent.ts` |
| Evaluator-owned expectations excluded from runtime | Frozen gold checks implementation independently; synthetic authoring lineage still limits generalization | `evals/src/contribution/independence.test.ts`, [baseline](../evals/reports/contribution/2026-10-24-baseline.md) |

## Dated primary sources

The [research register](research.md#source-register) records these sources as
opened on **2026-10-18**. Dates below are the source dates or versions recorded
there. They describe that research snapshot.

| Source | Date or version in the register | Use in the article and limit |
| --- | --- | --- |
| S01, [CMS FY2024 statistics](https://www.cms.gov/files/document/pre-claim-review-program-statistics-document-fy-24.pdf) | FY2024, page 8 | 175,577 completed DMEPOS requests and 72.9% provisionally affirmed across categories; documentation appeal note motivates evidence work, without a K0823-specific or causal estimate |
| S04, [CMS-0057-F fact sheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f) | 2024-01-17 | Payer scope and operational/API distinction; no Noridian endpoint contract follows |
| S05, [CMS-0062-P fact sheet](https://www.cms.gov/newsroom/fact-sheets/2026-cms-interoperability-standards-prior-authorization-drugs-proposed-rule) | 2026-04-10 | Proposed drug/interoperability context in the research snapshot; drugs are outside this lab |
| S06, [CMS DMEPOS operational guide](https://www.cms.gov/Research-Statistics-Data-and-Systems/Monitoring-Programs/Medicare-FFS-Compliance-Programs/DMEPOS/Downloads/Operational-Guide-for-DMEPOS-PA-current.pdf) | Updated 2026-09-02 | Request process and supplier handling; guidance is a dated policy input |
| S07, [CMS DMEPOS program](https://www.cms.gov/data-research/monitoring-programs/medicare-fee-service-compliance-programs/prior-authorization-and-pre-claim-review-initiatives/prior-authorization-process-certain-durable-medical-equipment-prosthetics-orthotics-and-supplies) | Retrieved 2026-10-18; register describes probation from 2026-10-15 | Explains explicit supplier-status scope; no actual supplier status is inferred |
| S08, [LCD L33789](https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?LCDId=33789) | Revision effective 2025-10-01 | Category-specific requirements and practitioner order authorship; clinical interpretation remains qualified work |
| S09, [Article A55426](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=55426) | Retrieved current article, 2026-10-18 | Existing order elements and WOPD context; policy-specific rules take precedence |
| S10, [Article A52498](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=52498) | Retrieved current article, 2026-10-18 | Practitioner/LCMP sequencing; incorporated LCMP branch routes to human review |
| S11, [Noridian JD PMD process](https://med.noridianmedicare.com/web/jddme/cert-reviews/mr/pre-claim/required-programs/prior-authorization-for-pmds) | Updated 2026-03-25 | Documentation and follow-up process; broad PMD list is not a one-code checklist |
| S12, [Noridian PMD checklist](https://med.noridianmedicare.com/documents/2230715/26734435/Documentation%2BChecklist%2B-%2BPower%2BMobility%2BDevices.pdf) | Updated 2025-08-13 | Lifecycle orientation; proof of delivery is not imposed on initial packet readiness |
| S13/S14/S16, [CRD](https://hl7.org/fhir/us/davinci-crd/en/burden.html), [DTR](https://www.hl7.org/fhir/us/davinci-dtr/en/specification.html), [PAS](https://hl7.org/fhir/us/davinci-pas/2.2.1/en/specification.html) | Published 2.2.1 / 2.2.0 / 2.2.1 | Requirements discovery, administrative/clinical collection and request/response boundaries; the local fixture adapter makes no conformance claim |
| S17/S18, [Synthea](https://github.com/synthetichealth/synthea), [maintainer FAQ](https://github.com/synthetichealth/synthea/wiki/Frequently-Asked-Questions) | Repository retrieved 2026-10-18; FAQ updated 2025-09-22 | Synthetic FHIR and realism limits; this lab's wheelchair fixtures are original authored inputs |
| S22, [HHS minimum-necessary guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/minimum-necessary-requirement/index.html) | Retrieved 2026-10-18 | Purpose-limited handling and exceptions; synthetic engineering is not a compliance assessment |

## Claim-to-evidence map

Paths in the artifact column are repository-root-relative. Documentation records
historical outcomes; test sources establish what a check asserts. Source inspection
and the presence of a test do not establish a run result.

| Claim | Artifact path | What it shows | Limits |
| --- | --- | --- | --- |
| Deterministic rules control administrative findings and state | `packages/domain/src/v2/assess.ts`; `apps/api/src/cases/service.ts`; `ARCHITECTURE.md` | Pure assessment and API revalidation of results against stored bytes | Administrative policy subset; clinical sufficiency is outside its authority |
| Historical rules and live graph share issue results | `evals/reports/live-claude/2026-10-21-full.md` and `.json` | Both arms have issue precision/recall 49/49 and false-ready 0/13 over 22 cases | Graph inherits rules; equal scores do not measure retrieval benefit |
| Recorded graph proposals pass through real worker/API/human boundaries | `docs/demo.md`; `packages/agents/recordings/missing-order-investigation.json`; `apps/worker/test/agent-recorded.integration.test.ts` | Scripted valid fact/request and rejected invented/low-confidence candidates; persisted review boundary | Authored provider turns; model behavior is established separately |
| Actual Claude behavior is recorded | `evals/reports/live-claude/2026-10-21-full.md` and `.json` | 2026-10-21: 22 finished runs, 128 calls, 223/223 supported accepted facts matching deterministic extraction, 4/6 request proposals accepted, zero observed prohibited attempts/executions | Small synthetic sample and shared lineage; evaluator port mirrors the API gate; tool surface is allowlisted; live model did not exercise scripted adversarial rejections |
| Historical provider cost and latency are inspectable | `evals/reports/live-claude/2026-10-21-full.json`; `evals/reports/live-claude/2026-10-21-smoke-f01.json` | Full run USD 1.8407536, smoke USD 0.0987340, combined USD 1.9394876; full-run median case 33,718 ms vs rules about 2 ms | Observations at the report revisions, not current account liability, prices or a population estimate |
| Contribution baseline separates retrieval and requests from inherited safety | `evals/reports/contribution/2026-10-24-baseline.md` and `.json` | 14/14 required facts, 82/82 supported extractions, 0/1 useful requests, 3/3 abstentions, false-ready 0/4; excluding R06 issue precision/recall 11/11 | Rules-only regression cohort; no incremental agent-effect claim |
| The CR01+CR03 subset has a limited positive ceiling | `evals/reports/contribution/2026-10-24-baseline.md`; `evals/src/contribution/evaluate.ts` | Baseline 8/8 required facts and 0/1 requests leaves +0/8 facts and +1/1 useful requests | Ceiling arithmetic describes the fixed cohort; it is not an observed agent result |
| Evaluator-only fakes validate scorer behavior | `evals/reports/contribution/2026-10-24-baseline.md`; `evals/src/contribution/fakes.ts`; `evals/src/contribution/scorer.test.ts` | Omitted facts, invalid values/locators/hashes, low confidence, malformed/truncated output, duplicates and observable prohibited attempts affect the intended metrics | Scripted turns use the evaluator port; narrative final advice is outside detector scope |
| Local requests are simulated and source-linked | `docs/connectors/local-fixtures.md`; `apps/api/src/workflow/service.ts` | Fixed fixture registry, approved request hash, unique local receipt and archived response creating revision 2 | No external transmission, payer decision or FHIR exchange |
| Restart and fresh-volume restore preserve the offline workflow | `docs/operations.md#recorded-verification`; `scripts/demo/smoke.sh`; `scripts/demo/walkthrough.mjs` | Recorded 59-check smoke on 2026-10-21: request loop, restart, backup, fresh restore and completion of a waiting recorded run | HTTP through BFF on macOS arm64/Docker Desktop; source-specific offline evidence |
| Container lifecycle and boundaries have historical observations | `docs/operations.md#recorded-verification`; `docs/development.md#container-experiments`; `scripts/container/container.test.ts` | 15 tests in 13 groups passed in 506 seconds; documented mutation checks cover failure sensitivity | Historical macOS arm64 run; current source has 14 groups and its matrix is described separately |
| Live admission has a defined authority and recovery boundary | `docs/adr/0001-packaged-live-agent.md`; `apps/api/src/accounting/ledger.ts`; `apps/worker/test/agent-live.integration.test.ts` | API-only ledger, reservation/grant protocol, exact caps, unknown holds, fencing and review-only resume; fake-provider check surfaces | Design/source and offline fake evidence; the historical live reports describe the separate evaluator path |

The contribution detector table must remain part of any technical discussion.
It separates observable tool/proposal events from narrative claims and actions
absent from the tool surface. “Unmeasured” detector entries cannot be presented
as zero violations. Source-supported extraction precision and required-target
recall also have different denominators: 82 supported baseline facts include
14 required targets.

## Article outline

1. The operator's problem: a missing document creates a versioned request loop.
2. Define the outcome: administrative evidence readiness and human review.
3. Show the queue, source-linked case evidence and reviewer packet.
4. Explain scope: K0823, California, Medicare FFS, explicit supplier context.
5. Walk through a neutral request, unique simulated receipt and reassessment.
6. Show authority: deterministic rules, scoped tools and revision-bound decisions.
7. Explain durable jobs, replay and source-preserving restart/restore.
8. Separate recorded graph behavior from actual Claude evaluation evidence.
9. Read the results with denominators: inherited safety, extraction and utility.
10. Explain the contribution baseline, ceiling arithmetic and detector scope.
11. Explain accounting admission and safe stopping at model-call boundaries.
12. State technical scope: synthetic inputs, local exchanges, structured sources
    and administrative outcomes.
