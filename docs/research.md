# Prior authorization evidence readiness research

Research date: 2026-10-18. This note records the dated public-source research.
The proposed product contract is [SPEC.md](../SPEC.md). This is an agentic
solution use case built on synthetic cases. No practitioner interviews, customer records,
clinical validation, or payer connections were available.

## Recommendation

Build an administrative evidence coordinator for initial Medicare fee-for-service
(FFS) power wheelchair requests, initially K0823, Noridian Jurisdiction D, and an
established supplier whose non-exempt status is explicitly supplied. The operator
is a fictional DME supplier's authorization coordinator. The outcome is an
inspectable packet for qualified human review, with missing information and
clinical questions left visible.

This is narrower than an authorization approval assistant. It can be evaluated
without pretending that an engineer can judge medical necessity. The product
hypothesis is that connecting scattered existing documents and coordinating
missing information makes this operator's work easier. That hypothesis remains
unvalidated.

## Evidence and its limits

CMS's FY2024 DMEPOS table records 175,577 completed requests and 72.9% provisionally
affirmed across several equipment categories. A footnote identifies additional
documentation absent during initial review as the most common reason for Level-1
appeal overturns [S01, page 8]. This supports investigating documentation work. It
does not establish a K0823-specific error rate, avoidable denial rate, or likely
benefit from this use case.

The AMA's 2025 survey, released in May 2026, reports 13 hours of physician and staff
time weekly on prior authorization among 1,000 physician respondents [S02]. It is
self-reported, broad workflow evidence. It is not a baseline for DME suppliers.

Waystar already offers requirements discovery, authorization attachments,
submission, and status automation [S03]. Novelty is not a defensible claim. The
value of this use case is explaining scope, integration boundaries, evidence provenance,
failure recovery, and results an evaluator can reproduce.

## Findings that change the scope

### Choose the actual payer process

CMS-0057-F applies to specified Medicare Advantage, Medicaid/CHIP, and FFE QHP
payers. Operational requirements generally start in 2026 and APIs generally in
2027; drug prior authorization is excluded [S04]. Medicare FFS DMEPOS uses its own
process [S06]. Do not imply that the first rule provides a Noridian FHIR endpoint.

The current CMS overview still identifies CMS-0062-P as proposed. Its drug and
standards changes are context, not implemented obligations for this use case
[S05, S15]. Do not copy the 2024 rule's decision clock into a different process.

The DMEPOS operational guide, updated September 2, 2026, identifies request
information, available submission channels, and supplier exemption handling [S06].
The current program page also reports a probationary process for newly enrolled
suppliers and certain ownership changes from October 15, 2026 [S07]. The first
lab excludes those circumstances. Unknown supplier status must stop automatic
readiness, even when the rest of the packet looks complete.

### Organize evidence without creating the order

L33789 distinguishes general wheelchair coverage from additional requirements
for particular categories. It also says the practitioner completing the
face-to-face requirements must write the base-item order, and that a supplier may
provide a template but must not fill its elements [S08]. Consequently, the agent
must never draft a wheelchair order, signature, diagnosis, or clinical
justification. It may request an existing finalized document and index it.

A55426 defines the standard written order and its required elements. A written
order prior to delivery is a completed order communicated to the supplier before
delivery; the face-to-face interval is six months [S09]. A52498 adds detail when an
LCMP evaluation is incorporated into the practitioner's record [S10]. That
additional sequencing is excluded from automatic readiness in the first lab.

Noridian's PMD process page lists documentation, rejection causes, submission
channels, and affirmative/non-affirmative follow-up [S11]. Its broad equipment
list is not a K0823-specific decision table. The lab must not impose complex-chair
requirements simply because they appear on that general page. Noridian places
home assessment and proof of delivery in the post-affirmation workflow; initial
packet readiness must not require evidence of a delivery that has not happened.

The supplier checklist is useful orientation, but spans multiple categories and
the full equipment lifecycle [S12]. It cannot replace a scoped requirements map.

### Preserve clinical and administrative responsibilities

Clinical sufficiency is not reducible to a file being present. A diagnosis alone
does not establish that a particular device is appropriate. The proposed lab
always leaves clinical questions for qualified review. Extracted statements are
linked to their source and cannot become new medical assertions.

The DTR specification explicitly separates administrative data collection from
questions requiring patient or clinical input, and warns that absent data may be
restricted rather than nonexistent [S14]. These are useful design constraints even
before implementing DTR.

## Interoperability feasibility

| Boundary | Verified resource | What can be built locally | What is not established |
| --- | --- | --- | --- |
| Record retrieval | Synthea FHIR R4 export [S17] | Read synthetic resources and document references | A production EHR connection or realistic wheelchair record distribution |
| Requirements discovery | CRD 2.2.1 [S13] | Versioned local policy lookup; later a CRD exercise | A live Noridian CRD endpoint |
| Documentation collection | DTR 2.2.0 [S14] | Evidence mapping; later a synthetic questionnaire interaction | A payer-approved K0823 questionnaire or complete conformance |
| Request/response | PAS 2.2.1 [S16] | Later a local reference-server exchange | Payer enrollment, trading agreements, real approval, or payment |
| Reference payer | HL7 Da Vinci br-payer [S19-S21] | Run a local reference server with synthetic scenarios | A deployed, tested integration in this repository |

CRD discovers requirements at workflow points; DTR collects relevant information;
PAS exchanges prior authorization requests and responses [S13-S16]. Published
versions above were checked on the research date. Continuous builds are not
frozen specifications. A coding task must recheck and pin its actual dependencies.

The reference payer repository is Apache-2.0, documents Java 17+ and Maven for its
server, and provides CRD, DTR, and PAS operations [S19]. Its startup guide describes
continuous-build package downloads and an in-memory default database [S20]. The
implementation task must pin compatible packages and choose persistence before
claiming reproducibility. Some reference rules use VSAC terminology requiring an
account/key. The initial lab must not depend on that access.

The reference server generates scenarios from its own rule metadata [S21]. These
are useful protocol examples, but cannot serve as independent evidence that our
policy interpretation is correct. The implemented connector boundary consists of
packaged fixture reads and local simulated receipts, as described in
[the local fixture adapter](connectors/local-fixtures.md). It has no EHR or payer
connection, hosted sandbox dependency or trading relationship. Any later
transport would be an explicit local reference or mock, never a disguised
production connector.

## Data rights and representation

Synthea software is Apache-2.0 and can generate FHIR R4 records [S17]. Its maintainers
describe limited diversity and unusually complete records, unlike the gaps and
inconsistencies in real records. It is not an anonymizer and cannot automatically
make realistic data for arbitrary implementation guides [S18].

Use original, visibly synthetic documents for wheelchair-specific cases. Record
generator version, seed, configuration, and modifications if Synthea is used.
Label authored fixtures separately. Do not import real notes or claim that
Synthea provides a prior authorization benchmark. Preserve upstream notices for
redistributed materials and inspect sample-data terms independently of software
licenses.

CMS coverage pages carry notices concerning third-party code sets. Link to the
policies and write concise original summaries. Do not vendor policy text,
questionnaire wording, CPT dictionaries, or reference content wholesale. Using a
publicly visible page does not grant blanket redistribution rights.

HHS minimum-necessary guidance includes exceptions, including treatment and some
required transaction disclosures [S22]. Purpose-limited reads and exports are a
sound lab design choice. The lab does not assert that a single legal rule covers
every future workflow, or that synthetic-only engineering establishes HIPAA
compliance. Real deployment would need a separate qualified assessment.

## Proposed evaluation and disconfirming tests

Freeze source-derived administrative expectations before writing the extraction
or workflow engine. Another engineer reviews those expectations and adversarial
cases. This is an engineering review, not clinical validation.

Compare a rules-only baseline and agent-assisted retrieval using the same policy
checks, fixtures, and output schema. A manual checklist can provide a qualitative
comparison; any developer timing must be labeled as such. Model outputs must not
grade themselves. Gold evidence locations, expected blockers, and prohibited
actions are independently written fixture data.

The critical suite in [the specification](../SPEC.md#critical-fixture-suite) tests
identity, source scope, unsigned orders, chronology, stale revisions, unsupported
requests, prompt injection, extraction failure, and recovery after interruption.
Measure issue precision/recall, exact evidence references, false-ready outcomes,
prohibited actions, duplicates, and recovery. Report denominators and failures.

The research would be disconfirmed as a useful product direction if the agent
adds no retrieval value over a checklist, creates extra review work, or cannot
reliably distinguish missing documentation from a clinical judgment. In that
case, publish the result and retain the simpler system. Synthetic performance
cannot establish reduced patient delays, clinician time saved, approval lift,
lower denial rates, or payment recovery.

## Source register

All sources below were opened on 2026-10-18. Dates are source dates where stated;
otherwise they describe the retrieved version. No search snippet alone is used as
the basis of a requirement.

| ID | Source and date/version | Evidence used and limitation |
| --- | --- | --- |
| S01 | [CMS FY2024 prior authorization statistics](https://www.cms.gov/files/document/pre-claim-review-program-statistics-document-fy-24.pdf), FY2024, page 8 | DMEPOS volumes and documentation-related appeal note; categories aggregated, no causal experiment estimate |
| S02 | [AMA physician survey release](https://www.ama-assn.org/press-center/ama-press-releases/ama-survey-prior-authorization-reform-pledge-falls-short-physicians), 2026-05-13 | Burden from 2025 survey; self-report, not DME-specific |
| S03 | [Waystar Authorization Manager](https://www.waystar.com/our-platform/financial-clearance/authorizations/), retrieved current page | Existing commercial capabilities; vendor claims are not our measured results |
| S04 | [CMS-0057-F fact sheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f), 2024-01-17 | Impacted payer scope and final-rule/API distinction; not a Noridian endpoint contract |
| S05 | [CMS-0062-P fact sheet](https://www.cms.gov/newsroom/fact-sheets/2026-cms-interoperability-standards-prior-authorization-drugs-proposed-rule), 2026-04-10 | Proposed drug and interoperability changes, not final obligations |
| S06 | [CMS DMEPOS operational guide](https://www.cms.gov/Research-Statistics-Data-and-Systems/Monitoring-Programs/Medicare-FFS-Compliance-Programs/DMEPOS/Downloads/Operational-Guide-for-DMEPOS-PA-current.pdf), updated 2026-09-02 | Sections 4-7: PAR, suppliers and PMDs; operational guidance, subject to change |
| S07 | [CMS current DMEPOS prior authorization program](https://www.cms.gov/data-research/monitoring-programs/medicare-fee-service-compliance-programs/prior-authorization-and-pre-claim-review-initiatives/prior-authorization-process-certain-durable-medical-equipment-prosthetics-orthotics-and-supplies), retrieved current page | 2026 exemption/probation and code-list changes; do not infer a supplier's actual status |
| S08 | [CMS LCD L33789](https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?LCDId=33789), revision effective 2025-10-01 | Category-specific boundaries and order authorship; clinical criteria require qualified interpretation |
| S09 | [CMS article A55426](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleid=55426), retrieved current article | Standard written order and WOPD; related policy-specific rules take precedence |
| S10 | [CMS article A52498](https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=52498), retrieved current article | Practitioner and LCMP sequence; clinical review cannot be automated by file presence |
| S11 | [Noridian JD PMD prior authorization](https://med.noridianmedicare.com/web/jddme/cert-reviews/mr/pre-claim/required-programs/prior-authorization-for-pmds), updated 2026-03-25 | Operator workflow and rejection reasons; generic PMD list, not one-code checklist |
| S12 | [Noridian PMD documentation checklist](https://med.noridianmedicare.com/documents/2230715/26734435/Documentation%2BChecklist%2B-%2BPower%2BMobility%2BDevices.pdf), updated 2025-08-13 | Lifecycle orientation; not automatically all required at initial PA stage |
| S13 | [HL7 CRD burden reduction](https://hl7.org/fhir/us/davinci-crd/en/burden.html), published 2.2.1 | Responsibilities and relationships between guides; no conformance claimed |
| S14 | [HL7 DTR specification](https://www.hl7.org/fhir/us/davinci-dtr/en/specification.html), published 2.2.0 | Administrative/clinical separation, restricted data, structured collection |
| S15 | [CMS electronic prior authorization overview](https://www.cms.gov/priorities/electronic-prior-authorization/overview), retrieved current page | Cross-check that CMS-0062-P is still presented as proposed |
| S16 | [HL7 PAS specification](https://hl7.org/fhir/us/davinci-pas/2.2.1/en/specification.html), published 2.2.1 | Request/response boundary and required trust setup; FHIR-shaped JSON alone is not conformance |
| S17 | [Synthea repository](https://github.com/synthetichealth/synthea), retrieved current README/license | Synthetic FHIR export and Apache-2.0 software; not a ready PA case corpus |
| S18 | [Synthea maintainer FAQ](https://github.com/synthetichealth/synthea/wiki/Frequently-Asked-Questions), updated 2025-09-22 | Limits of realism, completeness, and IG adaptation |
| S19 | [HL7 Da Vinci br-payer](https://github.com/HL7-DaVinci/br-payer), retrieved current README/license | Local Apache-2.0 reference server and access prerequisites; outside the implemented connector scope |
| S20 | [br-payer running guide](https://br-payer.davinci.hl7.org/docs/getting-started/running/), retrieved current guide | Runtime package loading and persistence defaults; must pin before use |
| S21 | [br-payer scenarios](https://br-payer.davinci.hl7.org/docs/clinical-content/scenarios/), retrieved current guide | Synthetic protocol examples derived from rules, not independent evaluation |
| S22 | [HHS minimum-necessary guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/minimum-necessary-requirement/index.html), retrieved current guidance | Privacy principle and exceptions; not a deployment compliance assessment |

## Gaps and next evidence

| Gap | Consequence | Next evidence |
| --- | --- | --- |
| No DME coordinator or clinical reviewer | User value and medical completeness unvalidated | Seek qualified review before real workflow claims; not required to build bounded lab |
| No actual supplier status or credentials | Cannot route a real request | Synthetic explicit status only; real access is a separate task |
| No payer-approved K0823 questionnaire | Local policy map is an authored interpretation | Publish mapping and reviewer findings; no payer endorsement claim |
| No live EHR or payer connection | No deployment or transport claim | Local FHIR reference integration followed by separately authorized access work |
| No realistic PA corpus | Unknown real-world generalization | Publish synthetic provenance, perturbations, and all errors |
| No legal review of future deployment | No PHI or compliance claim | Separate review if scope ever expands to real records |
