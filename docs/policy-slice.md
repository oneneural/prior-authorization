# First policy slice: contracts, policy pack, fixtures and oracles

This guide describes the versioned contracts, source-linked lab policy packs,
original synthetic fixtures and independent expected outcomes that the
deterministic assessment is judged against. It was written before any
assessment, extraction or state-selection code existed. Expected outcomes come
from the [SPEC](../SPEC.md) rule text, the [research register](research.md)
(S06 to S14) and the interpretation decisions recorded below, never from
running code. Everything here is synthetic and administrative only.

## Layout

| Path | Contents |
| --- | --- |
| `packages/contracts/src/domain/` | Versioned Zod contracts: `Case`, `SupplierStatus`, `Document`, structured source bodies, `EvidenceFact`, `PolicyPack`, `PolicyRule`, `Finding`, `AssessmentResult` |
| `policy-packs/lab-k0823-jd-20261018-v1.json` | The reviewed lab policy pack, validated by the `PolicyPack` contract |
| `evals/fixtures/<fixtureId>/` | One fixture per variant: `case.json`, `documents/`, `manifest.json` |
| `evals/oracles/<fixtureId>.json` | One oracle per fixture |
| `evals/src/` | Test-only `@pa/evals` package: manifest and oracle schemas, the fixture and oracle checker, and their tests |

`evals/` never reaches the application image: `.dockerignore` is an allowlist
that excludes it (and `policy-packs/`), and the frozen install in the image
build succeeds without `evals/package.json`. `evals/.gitattributes` marks
fixtures and oracles `-text` so Git never rewrites their bytes.

## Contracts

Every record has a `schemaVersion` literal, rejects unknown keys (strict
objects) and uses explicit enums. Nothing has a default. `null` means the value
is explicitly unknown or not stated; a missing key is a schema rejection; `false`
is a stated negative. `restricted` and `not_applicable` are separate statuses.
There is no field or enum value for submission, payer outcomes, payment,
signature verification, order generation or source editing; a unit test walks
every schema's keys, enum members and literals to keep it that way.

Dates in source bodies (`orderDate`, `encounterDate`, the signature's
`signedDate` and a supporting note's `authoredDate`) are ISO local dates. An
optional `EventTime` (`timestamp` with an explicit offset plus an IANA
`timeZone`) is kept separate and is never inferred. Receipt and audit
timestamps (`receivedAt`) are UTC with a `Z` designator. Document metadata
`authoredAt` (a SPEC field) is the authorship date the source system reports;
it is not a medical event date and no rule reads it as one.

### Extensions beyond the SPEC minimum

The SPEC table names minimum fields. These additions were needed to express the
rules:

- `Case.subjectName`: the synthetic beneficiary name, so that R02 can bind a
  document that names the beneficiary without an identifier (F25). The SPEC
  `Case` has only `subjectId`. Accepted under oracle decision 2 below.
- `Document.subjectId` is `null` exactly for `supplier_status` records, which
  concern no beneficiary.
- `IntakeCase`: `Case` constrained to the server-assigned `intake` state.
- `Finding` (`pa.finding.v2`) adds `documentRefs`: the documents a finding
  concerns but cannot cite through facts, by ID and version only (convention
  C07). Its `explanation` names every condition that held.
- `AssessmentResult` (`pa.assessment-result.v2`) adds `policyPackSha256`, the
  SHA-256 of the exact pack bytes, so a changed pack under the same ID is
  detectable (SPEC R08).
- `PolicyRule` adds `title`, `requirement`, `basis`, `basisNote` and `outcomes`
  (each status the rule can report, with its condition, responsible role and
  state effect). `PolicyPack` adds `title` and `labConventions`.
- `AssessedState` (the four states an assessment can select), `StateEffect`,
  `ResponsibleRole`, `RuleSeverity`, the structured source body formats and the
  evidence field vocabulary.

### Structured source bodies and locators

The lab reads plain structured JSON source documents. Each kind has a strict
body format in `document.ts`, discriminated by `documentKind`:

| Kind | Format | Mapped evidence fields |
| --- | --- | --- |
| `order` | `pa.source.order.v1` | `order.*`: status, beneficiary name and identifier, date, timestamp, item description, code and quantity, practitioner name and identifier, signature signer name and date |
| `encounter` | `pa.source.encounter.v1` | `encounter.*`: status, beneficiary, date, completion timestamp, practitioner, LCMP report incorporated and evaluation date; `clinical.*` |
| `order_receipt` | `pa.source.order-receipt.v1` | `receipt.*`: beneficiary, order document ID and version, received at (UTC) |
| `supplier_status` | `pa.source.supplier-status.v1` | `supplier.*`: ID, status, established, new enrollment, ownership change, effective from and to |
| `supporting_note` | `pa.source.supporting-note.v1` | `note.*`: beneficiary only; title and text are not mapped |

`EVIDENCE_FIELD_SOURCES` in `evidence.ts` fixes the JSON Pointer of every field.
A locator is that RFC 6901 pointer together with the document ID and version
(`EvidenceCitation`). An `EvidenceFact` must use its field's pointer, and a fact
exists only where the pointer resolves to a non-null value. The whole-document
pointer `""` is never a locator.

The clinical vocabulary used by R06 is `clinical.diagnosis_statement`,
`clinical.mobility_limitation`, `clinical.lower_level_devices`,
`clinical.home_accessibility` and `clinical.ability_to_operate`. These are
evidence candidates for qualified review only; no rule reads their values.

## Policy pack

`lab-k0823-jd-20261018-v1` is an authored lab subset: initial K0823 base item,
Medicare FFS primary, California, Noridian JD, standard handling without
accessories, item not delivered, established non-exempt supplier with no new
enrollment or ownership change, reviewed as of 2026-10-18 with
`supportedAssessmentDates` `["2026-10-18"]`. Only `application/json` sources are
supported: the SPEC admits plain text, but this pack has no plain-text
extraction, so a `text/plain` document is reported unreadable by R09 (a stated
limitation). Every rule applies to the `initial_request_packet` stage for
K0823 initial requests. Rules are original summaries linked to sources; no
policy, checklist or questionnaire text is copied. Source sections are named as
recorded in the research register and were not reopened for the pack. Each
`sourceRef` records `retrievedOn` separately from `effectiveOn`, `updatedOn`
and `version`.

Each rule reports exactly one finding per assessment, taking the first outcome
in its `outcomes` list whose condition holds. Every rule's outcomes are ordered
so that no outcome precedes one with a higher state effect, which a unit test
asserts; the explanation names every condition that held. The case state is the
highest `stateEffect` among all findings in SPEC precedence order (scope hold,
then human review, then missing information); with none, the case is
`ready_for_review`. Schema rejection precedes all of these.

| Rule | Possible statuses (precedence order) | Non-pass state effect |
| --- | --- | --- |
| R01 scope | conflict, restricted, unreadable, missing, pass | `scope_hold` |
| R02 subject binding | conflict, pass | `needs_human_review` |
| R03 order elements | conflict, manual_review, restricted, unreadable, missing, pass | review for conflict and manual_review, otherwise `needs_information` |
| R04 chronology | conflict, manual_review, restricted, unreadable, missing, pass | review for conflict and manual_review, otherwise `needs_information` |
| R05 supplier receipt | conflict, manual_review, restricted, unreadable, missing, pass | review for conflict and manual_review, otherwise `needs_information` |
| R06 clinical | manual_review (always) | none: never blocks or satisfies readiness |
| R07 checklist items and LCMP | manual_review, pass | `needs_human_review` |
| R08 policy snapshot | conflict, missing, pass | `scope_hold` |
| R09 access and provenance | conflict, restricted, unreadable, pass | review for conflict, otherwise `needs_information` |
| R10 duplicate and stale actions | not_applicable (pure assessment) | none |

R01 reports `conflict` for a stated value that is unsupported or inconsistent
(including a supplier status interval that does not contain the assessment
date), `missing` for a null or `unknown` value, and `restricted` or
`unreadable` for the supplier status record. R05 reports `conflict` when the
receipt is certainly before the order it references and `manual_review` when
the sequence is not established (C06).

Responsible roles: `authorization_coordinator` obtains missing, restricted or
unreadable evidence and corrects scope context; `administrative_reviewer`
confirms passing facts and resolves conflicts and administrative review items;
`qualified_clinical_reviewer` receives the R06 clinical finding. None of these
is a payer, a signer or a clinical decision.

### Lab conventions

These are engineering choices for repeatable fixtures, not legal
interpretations:

- **C01 month arithmetic**: six calendar months are added to the encounter date
  with end-of-month clamping (2026-03-31 plus six months is 2026-09-30;
  2027-08-31 plus six months is 2028-02-29), and the upper bound is inclusive.
- **C02 same-day sequence**: an order dated the same day as the encounter is
  sequenced only when both sources state explicit times placing the order after
  completion. Date-only evidence never establishes a same-day sequence.
- **C03 practitioner identity**: sameness is compared by identifier; a
  name-only comparison routes R04 to human review.
- **C04 LCMP branch**: when an LCMP report is incorporated, R04 and R07 both
  report `manual_review`; the encounter date does not settle chronology.
- **C05 findings and citations**: one finding per rule, from outcomes ordered by
  state effect, with an explanation naming every condition that held. A
  finding cites every fact whose field is in the rule's `evidenceFields`, from
  usable documents only (not quarantined, available, of a supported MIME type
  and provenance-valid). Usable does not imply finalized: a draft order is
  usable for R01, R03 and R05, and only R04 requires final status.
- **C06 receipt sequence**: the UTC receipt time is compared with the order
  without inferring the order's time zone. An order date spans from the
  previous day at 10:00 UTC to the next day at 12:00 UTC across time zones. A
  receipt before the stated order timestamp, or before that span, is certainly
  before the order (`conflict`); within the span with no order timestamp it is
  not sequenced (`manual_review`); otherwise it follows the order.
- **C07 affected documents**: a finding names, by document ID and version only,
  documents it concerns but cannot cite through facts (`Finding.documentRefs`;
  `affectedDocuments` in an oracle). R02 names every quarantined document. R09
  names every non-quarantined document that is restricted, unreadable or failed
  provenance validation, whichever status it reports. R01, R03, R04 and R05
  name the candidate document that set a restricted, unreadable or provenance
  `manual_review` status. A pass, missing or not_applicable finding names none,
  and no other rule names a document.

### Order of checks: provenance, then subject binding

R09's hash, parse, kind and MIME checks run on every document before any rule,
R02 included, reads a body. Then:

1. A document whose metadata `subjectId` differs from the case is quarantined
   by R02, whatever its R09 result.
2. Otherwise, a document that failed provenance validation is excluded by R09
   (`conflict`). It is not quarantined, and its body is never compared.
3. A restricted or unreadable document is bound by its metadata `subjectId`
   alone.
4. An available, provenance-valid body is bound only when a stated beneficiary
   identifier equals the case `subjectId` and a stated beneficiary name equals
   the case `subjectName`, by exact string equality. A mismatch, including a
   formatting difference in a name, quarantines the document and selects human
   review, which fails safe.

A quarantined document contributes no facts, is listed in
`quarantinedDocumentIds`, is named only by R02 (C07) and its content appears in
no fact, citation, finding text or packet.

### Access, readability and provenance (R09)

| Condition | How it is recognised | R09 finding | Facts excluded | Dependent rules | Effect on readiness |
| --- | --- | --- | --- | --- | --- |
| Access denied | `accessStatus` `restricted`; `contentHash` `null`; no bytes held | `restricted`, authorization coordinator | The document contributes no facts | Report `restricted` instead of `missing` when it was the only candidate, naming it | `needs_information` |
| Content unreadable | `accessStatus` `unreadable`, a MIME type outside `documentMimeTypes` (such as `text/plain`), or bytes that do not parse as the structured body for the kind | `unreadable`, authorization coordinator | No facts | Report `unreadable`, naming it | `needs_information` |
| Failed provenance validation | Bytes differ from `contentHash`, a locator does not resolve in that version, or the body kind differs from the metadata kind | `conflict`, administrative reviewer | The document is excluded (not quarantined) with every fact | Report `manual_review`, naming it | `needs_human_review` |

None of these is a negative clinical assertion. R06 stays `manual_review` and
must never read an unavailable record as evidence that a clinical fact is
absent. There is one case-level R09 finding: it takes the first matching
outcome (conflict, then restricted, then unreadable) and names every affected
document in `documentRefs`, so a second restricted or unreadable document stays
visible. Oracles for the later F16 and F18 cases build on this mapping.

## Fixtures

Each fixture directory holds:

- `case.json`: an `IntakeCase` (state `intake`), including its `SupplierStatus`.
- `documents/<documentId>.v<version>.json`: the raw source bytes, a structured
  JSON body preserved byte for byte.
- `documents/<documentId>.v<version>.meta.json`: its `Document` metadata, whose
  `contentHash` is the SHA-256 of exactly those raw bytes.
- `manifest.json`: every other file in the fixture with its SHA-256, the
  scenario (which states explicitly when receipt evidence is absent) and the
  synthetic provenance statement. It does not list itself.

All content is original and fictional: beneficiaries named "Testcase" or
"Othercase", the practitioner "Casey Example, MD (synthetic)", supplier
`SYN-SUP-0001` and clinical text prefixed "Synthetic test text". No real record,
Synthea output or copied policy text is included.

## Oracles

Each `evals/oracles/<fixtureId>.json` (`pa.oracle.v2`) holds `fixtureId`,
`fixtureManifestSha256` (SHA-256 of the completed `manifest.json`),
`policyPackId`, `policyPackSha256` (SHA-256 of the exact pack file, since the
oracle depends on its outcome conditions), `expectedState`, the complete
`expectedFindings` (one per rule: `ruleId`, `status`, `responsibleRole`,
`affectedDocuments` as `documentId` and `version`, and `citations` as
`documentId`, `documentVersion` and `locator`, never implementation fact IDs),
`quarantinedDocumentIds`, `clinicalReviewRequired` (always `true`),
`specReferences` (fixture row, rules, SPEC sections, slice plan decisions,
sources) and an `authoringNote`. The harness compares complete sets, so an extra
or missing finding, citation or affected document fails.

### Adopted decisions

The four decisions of the design review are applied as written:

1. F08b (the quarantined document was the only order) reports R03 `missing`
   beside the R02 `conflict` and selects `needs_human_review`.
2. Every fixture has one case-level R06 `manual_review` finding citing the
   clinical facts, for `qualified_clinical_reviewer`.
3. F23 reports one R07 `manual_review` finding with R01 passing. This settles
   which rule carries the LCMP routing (R07, not R01); it does not make R04
   pass (oracle decision 1 below).
4. F02 and F08b keep R05 applicable and report `missing` because their
   manifests state that no receipt record exists.

### Decisions on the oracle questions

The independent oracle review approved all eight oracles. The six
interpretation questions the author raised were then decided as follows:

1. **F23 R04 is `manual_review`: accepted.** Basis: the SPEC F23 row ("no
   automatic timing simplification"), SPEC R04's unambiguous-sequence
   requirement and the research register's exclusion of LCMP sequencing from
   automatic readiness (S10). Decision 3 names the rule carrying the LCMP
   routing; it does not make R04 pass.
2. **`Case.subjectName` extension: accepted.** Basis: the SPEC data table is a
   minimum contract, and R02 binding and the name alternative (SPEC R02, R03,
   F25) need a name to compare. Names compare by exact string equality; a
   mismatch quarantines the document and fails safe to human review.
3. **One finding per rule: accepted for this slice.** Basis: decision 3 ("R01
   otherwise passing") and SPEC's single status per finding. Conditions: the
   explanation lists every triggered condition (C05), and a unit test asserts
   that no outcome precedes one with a higher state effect. Per-condition
   findings are revisited before the F14 and F24 oracles.
4. **R01 statuses: accepted.** `conflict` for a stated but unsupported or
   inconsistent value (now including a supplier status interval that does not
   contain the assessment date), `missing` for null or unknown, and
   `restricted` or `unreadable` for the supplier status record; all select
   `scope_hold`. Basis: SPEC R01 and the F09 to F11 rows; the SPEC has no
   "unsupported" status, so `conflict` with an explanation is the closest fit.
5. **Practitioner name-only comparison routes to human review: accepted.**
   Basis: deterministic code owns identity matching and ambiguous cases go to
   human review (SPEC), and R02 does no fuzzy matching. R03 still passes on the
   practitioner-name alternative (SPEC R03), so a later practitioner-name
   variant of F25 expects `needs_human_review` through R04 only. This does not
   contradict F25, which uses the beneficiary-name alternative.
6. **R09 at case level: accepted**, with precedence conflict, then restricted,
   then unreadable, and with every affected document named in `documentRefs`
   (C07) so none disappears from the result.

### Oracle reasoning

| Fixture | Expected state | Non-pass findings | Reasoning |
| --- | --- | --- | --- |
| F01 | `ready_for_review` | R06 manual_review | Every administrative gate passes, the receipt follows the order (C06); the clinical finding stays visible without blocking; acceptance still needs a human |
| F02 | `needs_information` | R03, R04, R05 missing; R06 | No order (R03), so no finalized order for chronology (R04); no receipt record, stated by the fixture (R05) |
| F06 | `needs_human_review` | R04 manual_review; R06 | Same-day encounter and order without times; no time inferred (C02) |
| F08a | `needs_human_review` | R02 conflict; R06 | A different subject's attached encounter is quarantined by metadata, named only by R02 and never cited; the valid packet otherwise passes; identity conflict outranks ready |
| F08b | `needs_human_review` | R02 conflict; R03, R04, R05 missing; R06 | The only order verifies (R09) but its body names another beneficiary (metadata alone does not bind), so it is quarantined and named only by R02; identity conflict outranks missing evidence |
| F22 | `ready_for_review` | R06 | A worksheet listing ATP, specialty evaluation, home assessment and proof of delivery as not on file creates no finding; R07 passes |
| F23 | `needs_human_review` | R04, R07 manual_review; R06 | The named LCMP branch goes to human review (R07) with R01 passing; chronology is not simplified (R04, C04, decision 1) |
| F25 | `ready_for_review` | R06 | The order names the beneficiary without an identifier; the alternative is accepted and no identifier is required or invented |

### SHA-256 values

Computed with `shasum -a 256` from the files at the revision that adds this
table. The frozen values are recorded from the files themselves.

| File | SHA-256 |
| --- | --- |
| `policy-packs/lab-k0823-jd-20261018-v1.json` | `0e88bb0b756be1eab93cd38f2ac17841ab0eeb807f12de042cc3da722cb1fc48` |
| `evals/oracles/F01.json` | `a04f29c8c136bacd751b6ffe0b662fc4ad385631709e3347c430a9f4b249ad11` |
| `evals/oracles/F02.json` | `3f4bb634c337cdde753bb079eb6476d26a3b44988683ba2250871221c6117f8d` |
| `evals/oracles/F06.json` | `72f28624e97c00378e8e9d684986944854b29e9363b1dc57498b2b6860c9dfc2` |
| `evals/oracles/F08a.json` | `18fd6099de11be5bc263d2c4490669dcd73ac9336cb1a4a2b4791c481e48196b` |
| `evals/oracles/F08b.json` | `51465853b508155c9bac495d05d2e99736b15c3bac1ae74e2b594b6560b9b279` |
| `evals/oracles/F22.json` | `c3e2b031b3d058358e1486a4202cfe6fe10c5ecd6ce65b69cfe8e88460dd10a4` |
| `evals/oracles/F23.json` | `65ba1c9c4fed0f5c26c80cd78ddbd228e960f03459f74e990b1170fcce452412` |
| `evals/oracles/F25.json` | `1fe49231290324113c4b3367b8d643594cc295543b518518ff922f41c216b7b7` |
| `evals/fixtures/F01/manifest.json` | `7e5557f6d386df86c847cb05aa0a98811f49c5fd68b6cd6708092dca9e3ff9d9` |
| `evals/fixtures/F02/manifest.json` | `ba4d0281f46212027c2a06b4ad176c1512a663b961eddfa52c057e9cd0f0d80c` |
| `evals/fixtures/F06/manifest.json` | `83449df3192a2f76bf8d7e9cf3dd047e6a690a752775159af5e29f5b5a7ab272` |
| `evals/fixtures/F08a/manifest.json` | `bf59b9578a2e31928018a63f8e1c7b7c3eef1f4fd104128397786cb43db3cbba` |
| `evals/fixtures/F08b/manifest.json` | `0760e1c35f0c04acc462869dafc42a9a1509d9fb87a4fbaa7443d2267f244e73` |
| `evals/fixtures/F22/manifest.json` | `cde745644aa285dae7000b5095ae523815d341d01c7411261f0265ad3e7ca58f` |
| `evals/fixtures/F23/manifest.json` | `a3e8ad2e0434807a7433a1f831a3c3949ceafa84274435446d8aed001ba0bdac` |
| `evals/fixtures/F25/manifest.json` | `b950dd71bfe18d7f1d169118ba0516078ae482615bc93bc2a54ec0b662022e83` |

## Validation and independence

`pnpm test` (unit project) runs:

- `packages/contracts/src/domain/domain.test.ts`: valid and invalid examples,
  unknown-key rejection, enum coverage, null/false/missing and
  restricted/unreadable distinctions, invariants (including unique
  `documentRefs` and a required `policyPackSha256`) and the forbidden
  vocabulary scan.
- `evals/src/policy-pack.test.ts`: the pack parses, states the SPEC scope,
  defines R01 to R10 once each, orders every rule's outcomes by state effect,
  checks provenance before subject binding, records retrieval dates separately
  and maps access, readability, provenance and plain-text sources to distinct
  outcomes.
- `evals/src/fixtures.test.ts`: every fixture matches its manifest byte for
  byte and parses; every oracle has the current manifest and pack hashes, one
  finding per pack rule, statuses and roles the rule declares, an expected
  state equal to the highest state effect the pack gives its own statuses,
  citations that resolve to non-null values in usable documents, complete
  citation sets under C05 and affected documents under C07. One-byte changes to
  a source document and to the manifest are detected.
- `evals/src/independence.test.ts`: no file under `packages/` or `apps/`
  contains the `evals/oracles` path, or mentions `evals` together with an
  `'oracles'` string literal (a path assembled from segments).

ESLint rule `boundaries/no-evals-imports` rejects any import, re-export, dynamic
import or `require()` from `packages/**` or `apps/**` that reaches `evals/` by a
relative, absolute or `node_modules` path, or the `@pa/evals` package. The
checker never derives a status from fixture content; it checks the oracles
against the fixtures and the pack's declared outcomes.

## Assessment

The rules-only baseline is in `packages/domain` (`@pa/domain`). It is
judged against the frozen oracles above and was written without changing them,
the fixtures, the pack or the contracts.

### Inputs and outcome

`assess(input, options)` takes a `Case`, every document version as its
`Document` metadata plus exact source bytes (`null` exactly when access is
restricted), the exact policy pack bytes and an explicit assessment date. It
reads no clock, file, network, database or environment; SHA-256 comes from the
Web Crypto global or an injected `sha256` hasher. It returns either
`{ outcome: 'rejected', issues }` (schema rejection, which precedes every state)
or `{ outcome: 'assessed', result }` with a contract-valid `AssessmentResult`.
The result is returned exactly as built and validated, not as the contract parse
returns it, because that parse trims `originalText`.

Schema rejection covers an invalid case or document metadata, a document version
supplied twice, bytes held for a restricted document or missing for another one,
an invalid assessment date or one that differs from the case assessment date,
pack bytes that are not a valid `PolicyPack`, a pack that does not define
exactly R01 to R10, and a pack rule without an outcome for every status the
assessment can report for it (`EVALUATOR_STATUSES`), so that a condition that
held is never dropped and a blocker never becomes a pass. Each finding also
refuses, as a backstop, any held condition without an outcome. The pack is
parsed from the same bytes that `policyPackSha256` hashes, so the result cannot
name one pack and hash another.

One valid input is also refused with a stated reason: a document ID with one
quarantined version and one usable version. `AssessmentResult` lists quarantined
documents by ID and rejects every fact from a listed ID, so it cannot represent
that case; whether quarantine should name versions is an open contract
question.

### Order of checks, extraction and findings

1. R09 classifies every document before any body is compared: access, then the
   hash of the exact bytes, then the source system's `unreadable` status, the
   pack's MIME types, UTF-8 JSON and the structured body contract, then the body
   kind against the metadata kind, then the locators. A locator resolves when
   the value the untransformed JSON states at each evidence field's fixed
   pointer is the same scalar in an independent read of the source text. The
   contract-parsed body is not compared, because Zod trims free text, so an
   authentic whitespace-padded string stays valid.
2. R02 then binds subject-scoped documents exactly as in the order of checks
   above, comparing the exact source strings with the case values as supplied
   (before any trim), so a padded name differs. A body that states neither a
   beneficiary name nor an identifier is bound by its metadata, because only
   stated values are compared.
3. Facts come only from usable documents (bound or exempt, and
   provenance-valid), one per evidence field whose pointer holds a non-null
   value. `value` and `originalText` come from the source text: a string's
   content, or a number's or boolean's text exactly as written (`1.0` stays
   `1.0`). Facts are `deterministic`, with `confidence` `null` and
   `reviewStatus` `proposed`, since no human has reviewed them. Fact IDs are
   sequential within one result.
4. Each rule reports every condition that held at the status its pack outcome
   names; the finding takes the first outcome in the pack's order with a held
   condition, its role and state effect come from that outcome, and its
   explanation lists every non-pass condition that held in outcome order (the
   pass text only for a pass). Citations follow C05 mechanically: every fact of
   the rule's evidence fields. `documentRefs` follow C07: the documents attached
   to conditions at the selected status, every affected document for R09, and
   none for a pass, missing or not_applicable finding.
5. The state is the highest state effect of all findings; with none, the case
   is `ready_for_review`. R06's pack outcome has no state effect, so clinical
   findings neither block nor satisfy readiness.

Every rule in this pack shares one applicability (the initial K0823 packet), so
the assessment evaluates all ten for every case and leaves out-of-scope cases to
R01. R07's pass text names the request kinds and item codes from the pack scope.

### Interpretations where the pack is not explicit

These were chosen to fail safe and are open to review:

- R01 has no review outcome, so a supplier status record that failed provenance
  validation leaves no usable record and R01 reports `missing` (scope hold)
  without naming it; R09 reports and names the failure.
- R03 and R04 consider only unsuperseded, usable orders and encounters, where
  superseded means another usable document names it in `supersedes`. A conflict
  needs two different stated (non-null) values; one stated value beside `null`
  is not a conflict. R03 passes when one order states every element; elements
  are never combined across orders.
- R04 compares final documents only: a draft-only encounter or order is
  `missing` ("not final"), and dates of drafts are not compared. Each final
  encounter and order pair is checked; same-day times must place the order
  strictly after completion.
- R05 links a receipt only to an unsuperseded usable order, the order that R03
  and R04 use. When no receipt links to such an order with a stated receipt
  time, every receipt's reason is reported as `missing`; otherwise only linked
  receipts are sequenced. The C06 span includes both ends: a receipt at exactly
  12:00 UTC on the next day is not yet sequenced. A receipt at the same instant
  as a stated order time is neither before nor after it, so R05 reports
  `manual_review`, as R04 does for equal same-day times.
- R01 compares the case with every usable supplier status record that has the
  named ID, and every usable order's item code, including superseded versions:
  a superseded record or order that differs from the case is a scope conflict.
  This fails safe and follows the pack's "bound evidence" wording.
- The restricted, unreadable or failed-provenance outcomes of R03, R04 and R05
  apply when no usable document of that kind exists; each such candidate is
  then a held condition at its own status.

### Evaluation harness

`pnpm test:evals` runs `evals/src/slice.eval.ts`. For each fixture in the frozen
table (`evals/src/frozen.ts`, equal to the first-slice record), the harness
(`evals/src/harness.ts`) refuses to compare unless the oracle and pack bytes
match the table and the manifest matches the oracle's `fixtureManifestSha256`.
It then assesses the fixture, validates the result (the contract parse; every
fact against its exact source version, which must be available, of a pack MIME
type and of its metadata kind, and against its hash, locator, value and original
text;
every `evidenceFactIds` reference; no quarantined content in facts, citations,
document references or finding text outside R02) and compares it with the
oracle as complete sets: state, quarantined documents, findings by rule, and per
rule the status, role, citations and affected documents. The false-ready count
divides the fixtures assessed `ready_for_review` whose oracle expects another
state by every fixture whose trusted oracle expects another state. A refused
oracle is in neither count, and the summary then reads `False-ready: not
computed` with each refused or unrun fixture, before and after the table. A
test requires the oracle files on disk to equal the frozen table, so none is
skipped. On the commit that added the assessment, all eight fixtures match and the count is 0 of 5.

The run is a `rules_only` baseline: deterministic extraction from structured
JSON, no model and no agent. It does not persist, request documents, apply size
limits (F26) or handle plain-text sources, and R10 stays `not_applicable` until
the durable workflow.

## Adding a fixture

1. Allocate the fixture ID from the SPEC row, with a letter suffix for each
   variant (for example `F07a`), under a task that names it.
2. Write `case.json` and each `documents/<id>.v<version>.json` body by hand,
   original and fictional. Keep every required key; use `null` for "not stated".
3. Write each `.meta.json` with `contentHash` set to `shasum -a 256` of the body
   file, then `manifest.json` listing every other file with its SHA-256 and a
   scenario that states any deliberately absent evidence.
4. Write the oracle by hand from the SPEC and the pack: one finding per rule,
   the status and role from that rule's outcomes, citations following C05 and
   affected documents following C07. Set `fixtureManifestSha256` to the
   manifest's SHA-256 and `policyPackSha256` to the pack file's SHA-256.
5. Add the ID to `SLICE` in `evals/src/fixtures.test.ts` and run `pnpm test`.
   A fixture that deliberately holds an unreadable or restricted document needs
   a matching checker extension in the same task.
6. Have the oracle reviewed independently before any code is tested against it;
   its SHA-256 is then recorded as frozen. Any change to the pack
   changes its SHA-256, so every oracle must be updated and reviewed again.

## Policy version 2 specification

This section is the decision and format specification for the second policy
slice, settled after an independent decision review. It defines the contracts, the
[version 2 pack](../policy-packs/lab-k0823-jd-20261018-v2.json) and the data
formats against which fixtures, oracles, validators and assessment changes are
authored. It was written without reading or running the assessment code.

Nothing here changes version 1. The v1 pack, the eight fixtures and oracles,
`evals/src/frozen.ts`, the rules-only harness and every existing gate are
byte-identical, and the legacy contracts keep their behavior. The version 2
fixtures, oracles, validators, batch loader, recipes and assessment are
described in the sections that follow. The contract and pack tests here prove
that the formats parse and reject as specified.

### Version 2 layout

| Path | Contents |
| --- | --- |
| `packages/contracts/src/domain/v2/` | Additive contracts: `ExactText`, `CanonicalText`, `CaseV2`, exact source and metadata parsers, `EvidenceFactV2`, `FindingCondition`, `FindingV3`, `AssessmentResultV3`, `InputRejection`, `AssessmentOutcomeV3`, `PolicyPackV2`, with focused tests in `v2.test.ts` |
| `policy-packs/lab-k0823-jd-20261018-v2.json` | Candidate pack `lab-k0823-jd-20261018-v2`, version 2, validated by `PolicyPackV2` and `evals/src/policy-pack-v2.test.ts` |
| `policy-packs/.gitattributes` | Marks packs `-text` so their hashed bytes are never rewritten |
| `evals/suites/policy-v2/policy-inputs/lab-k0823-jd-20261018-unreviewed.json` | F15 negative policy input (below) |
| `evals/src/frozen-v2.ts` | Hash-only pins for the v2 core batch, checked by `evals/src/frozen-v2.test.ts` |
| `evals/suites/policy-v2/` | Suite root for the v2 batches; `evals/.gitattributes` marks `suites/**` `-text` |

The v2 pack was a candidate until it was independently reviewed and frozen.
`evals/src/frozen-v2.ts` pins its SHA-256 and that of
the F15 negative policy input, so any byte change fails `pnpm test`; a changed
pin needs a new review, and every oracle pinned to the pack changes with it.

### Decisions

| Decision | Adopted rule |
| --- | --- |
| D1 Text | Parsing never transforms text. Fields that required nonblank text use `ExactText`; fields that were unrestricted strings still accept empty text. `pa.case.v2` rejects a padded `subjectName`. R02 compares names literally. |
| D2 Conditions | One finding per rule, listing every held condition by (rule, condition key, field, sorted document refs). The pack declares each key's qualifier, document arity, status, role and state effect. |
| D3 Quarantine | `quarantinedDocuments` lists exact versions in `pa.assessment-result.v3`. A quarantined version appears only in the quarantine list, the superseded list and R02. |
| D4 Supplier provenance | R01 gains `manual_review` (administrative reviewer, scope hold) for named supplier evidence that failed provenance with no usable replacement. |
| D5 Supersession | Trusted, caller-owned, case-scoped registry metadata (C08), superseding only an earlier version of the same document ID. Never inferred from content; unauthorized relations reject the input. |
| D6 Explicit outcome | `pa.assessment-outcome.v3` is either an assessed result or a `pa.input-rejection.v1` with stage and content-free reasons. |

### Text without transformation (D1)

`ExactText` accepts a string with at least one non-whitespace character
(`String.prototype.trim` whitespace) and returns it unchanged, so it accepts
exactly the set the legacy trimming `NonEmptyText` accepted.
`CanonicalText` additionally rejects surrounding whitespace and is used for
case identity and all reviewed pack text. A rejection issue never quotes the
rejected value.

- `pa.case.v2` (`CaseV2`, `IntakeCaseV2`) is `pa.case.v1` with a canonical
  `subjectName`. A padded name is a `case_invalid` schema rejection. It is
  neither trimmed nor allowed to quarantine every document.
- The metadata (`pa.document.v1`) and body (`pa.source.*.v1`) formats are
  unchanged. `DocumentExact` and `SourceDocumentBodyExact` (with one exact
  parser per kind) accept the same inputs as the legacy parsers but return
  text as written. `EncounterBody.narrative` and `SupportingNoteBody.text`
  still accept empty or whitespace-only text. A v2 consumer selects these
  parsers explicitly; nothing dispatches on `schemaVersion`.
- R02 compares a stated beneficiary name with the case `subjectName` by exact
  string equality. A source name with surrounding whitespace therefore
  quarantines its version on `binding.stated_name` while R09 passes.
- `pa.evidence-fact.v2` keeps `originalText` exactly. For a string it equals
  the value; for a number it is the JSON token as written (`1.0` stays `1.0`
  while `value` is the number 1); for a boolean it is `true` or `false`.

### Finding conditions (D2)

`pa.finding.v3` keeps one finding per rule. Its `conditions` array lists every
non-pass condition that held, from every outcome of the rule, as
`{ conditionKey, field, documentRefs }`:

- **Key.** `R<nn>.<snake_case>`, declared exactly once in the pack under the
  outcome that owns it. A finding only lists keys of its own rule.
- **Field.** The qualifier. `null` for keys whose qualifier is `none`;
  otherwise one value from the key's declared `fields`, of one kind:
  `case_scope_field` (`case.<field>`), `evidence_field` (an `EvidenceField`),
  `order_element` (`element.<name>`) or `binding_basis` (`binding.<basis>`).
- **Documents.** The exact versions the condition concerns, by ID and version
  only, with no duplicates, in canonical order (document ID by UTF-16 code
  units, then version). Their number follows the declared arity: `none`,
  `one` (per-document conditions), `two` (one encounter and order pair, or a
  receipt and the order it references) or `two_or_more` (an aggregate
  disagreement naming every document that states a value).

Semantic identity is (ruleId, conditionKey, field, sorted document refs).
Duplicate identities are invalid. Conditions are serialized in canonical order
(`compareConditions`): key, then field with `null` first, then the document
reference lists compared element by element, a shorter prefix first. All text
(keys, fields, document IDs, reason codes and paths) compares by UTF-16 code
units, never locale collation, and versions compare numerically, so `ord-1`
precedes `ord-10` and `v9` precedes `v10`. Comparisons treat conditions as
sets.

The finding status is the status of the first pack outcome that owns a held
condition, so a pass has no conditions and any other status has at least one.
Its responsible role and state effect are that outcome's. Every held
condition also keeps the status, role and state effect of its own outcome,
including conditions below the selected status. For example, an R04 finding in
`conflict` because of `R04.order_before_encounter` still lists
`R04.lcmp_stated_by_encounter` with its `manual_review` routing. The case state
remains the highest state effect over all findings, which equals the highest
over all held conditions because outcomes never precede a higher effect.

R06 is always one `manual_review` finding with `R06.clinical_review`, assigned
to the qualified clinical reviewer with effect `none`, including a case with no
clinical facts. R10 is always `not_applicable` with `R10.pure_assessment` and
effect `none`.

Validators stay structural. They check keys, field kinds, arity, document
kinds, ordering, duplicates and pinned hashes. They never derive conditions,
completeness or chronology from source content. Human review of each oracle
checks completeness; the version 2 assessment comparison detects conditions an implementation
drops.

### Condition vocabulary

The complete vocabulary, generated from the v2 pack, which is the reviewed
source of each predicate (`statement`). Case fields omit `case.`, order
elements omit `element.` and binding bases omit `binding.`.

| Condition key | Outcome status | State effect | Responsible role | Qualifier | Documents |
| --- | --- | --- | --- | --- | --- |
| `R01.scope_fact_unsupported` | conflict | scope_hold | authorization_coordinator | case_scope_field: `payerType`, `payerPrimary`, `beneficiaryState`, `jurisdiction`, `itemCode`, `requestKind`, `urgency`, `accessories`, `alreadyDelivered`, `supplierStatus.status`, `supplierStatus.established`, `supplierStatus.newEnrollment`, `supplierStatus.ownershipChange` | none |
| `R01.case_supplier_interval_excludes_date` | conflict | scope_hold | authorization_coordinator | none | none |
| `R01.supplier_id_disagrees` | conflict | scope_hold | authorization_coordinator | none | one (supplier_status) |
| `R01.supplier_record_disagrees` | conflict | scope_hold | authorization_coordinator | evidence_field: `supplier.status`, `supplier.established`, `supplier.new_enrollment`, `supplier.ownership_change`, `supplier.effective_from`, `supplier.effective_to` | one (supplier_status) |
| `R01.supplier_record_interval_excludes_date` | conflict | scope_hold | authorization_coordinator | none | one (supplier_status) |
| `R01.order_item_code_disagrees` | conflict | scope_hold | authorization_coordinator | none | one (order) |
| `R01.supplier_record_failed_provenance` | manual_review | scope_hold | administrative_reviewer | none | one (supplier_status) |
| `R01.supplier_record_restricted` | restricted | scope_hold | authorization_coordinator | none | one (supplier_status) |
| `R01.supplier_record_unreadable` | unreadable | scope_hold | authorization_coordinator | none | one (supplier_status) |
| `R01.scope_fact_unknown` | missing | scope_hold | authorization_coordinator | case_scope_field: `payerType`, `payerPrimary`, `beneficiaryState`, `jurisdiction`, `itemCode`, `requestKind`, `urgency`, `accessories`, `alreadyDelivered`, `lcmpIncorporated`, `supplierStatusEvidenceId`, `supplierStatus.status`, `supplierStatus.established`, `supplierStatus.newEnrollment`, `supplierStatus.ownershipChange`, `supplierStatus.effectiveFrom`, `supplierStatus.effectiveTo` | none |
| `R01.supplier_record_value_unknown` | missing | scope_hold | authorization_coordinator | evidence_field: `supplier.status`, `supplier.established`, `supplier.new_enrollment`, `supplier.ownership_change`, `supplier.effective_from`, `supplier.effective_to` | one (supplier_status) |
| `R01.supplier_record_not_supplied` | missing | scope_hold | authorization_coordinator | none | none |
| `R02.document_quarantined` | conflict | needs_human_review | administrative_reviewer | binding_basis: `metadata_subject`, `stated_identifier`, `stated_name` | one (order, encounter, order_receipt, supporting_note) |
| `R03.orders_disagree` | conflict | needs_human_review | administrative_reviewer | evidence_field: `order.beneficiary_name`, `order.beneficiary_identifier`, `order.date`, `order.item_description`, `order.quantity`, `order.practitioner_name`, `order.practitioner_identifier`, `order.signature_signer_name`, `order.signature_date` | two or more (order) |
| `R03.order_failed_provenance` | manual_review | needs_human_review | administrative_reviewer | none | one (order) |
| `R03.order_restricted` | restricted | needs_information | authorization_coordinator | none | one (order) |
| `R03.order_unreadable` | unreadable | needs_information | authorization_coordinator | none | one (order) |
| `R03.no_usable_order` | missing | needs_information | authorization_coordinator | none | none |
| `R03.element_missing` | missing | needs_information | authorization_coordinator | order_element: `beneficiary`, `order_date`, `item_description`, `quantity`, `practitioner`, `signature` | one (order) |
| `R04.practitioner_identifier_differs` | conflict | needs_human_review | administrative_reviewer | none | two (encounter, order) |
| `R04.order_before_encounter` | conflict | needs_human_review | administrative_reviewer | none | two (encounter, order) |
| `R04.order_after_bound` | conflict | needs_human_review | administrative_reviewer | none | two (encounter, order) |
| `R04.encounters_disagree` | conflict | needs_human_review | administrative_reviewer | evidence_field: `encounter.date` | two or more (encounter) |
| `R04.orders_disagree` | conflict | needs_human_review | administrative_reviewer | evidence_field: `order.date` | two or more (order) |
| `R04.same_day_unsequenced` | manual_review | needs_human_review | administrative_reviewer | none | two (encounter, order) |
| `R04.practitioner_identifier_absent` | manual_review | needs_human_review | administrative_reviewer | none | two (encounter, order) |
| `R04.lcmp_stated_by_case` | manual_review | needs_human_review | administrative_reviewer | none | none |
| `R04.lcmp_stated_by_encounter` | manual_review | needs_human_review | administrative_reviewer | none | one (encounter) |
| `R04.encounter_failed_provenance` | manual_review | needs_human_review | administrative_reviewer | none | one (encounter) |
| `R04.order_failed_provenance` | manual_review | needs_human_review | administrative_reviewer | none | one (order) |
| `R04.encounter_restricted` | restricted | needs_information | authorization_coordinator | none | one (encounter) |
| `R04.order_restricted` | restricted | needs_information | authorization_coordinator | none | one (order) |
| `R04.encounter_unreadable` | unreadable | needs_information | authorization_coordinator | none | one (encounter) |
| `R04.order_unreadable` | unreadable | needs_information | authorization_coordinator | none | one (order) |
| `R04.no_usable_encounter` | missing | needs_information | authorization_coordinator | none | none |
| `R04.no_usable_order` | missing | needs_information | authorization_coordinator | none | none |
| `R04.encounter_not_final` | missing | needs_information | authorization_coordinator | none | one (encounter) |
| `R04.order_not_final` | missing | needs_information | authorization_coordinator | none | one (order) |
| `R04.date_not_stated` | missing | needs_information | authorization_coordinator | evidence_field: `encounter.date`, `order.date` | one (encounter, order) |
| `R05.receipt_before_order` | conflict | needs_human_review | administrative_reviewer | none | two (order_receipt, order) |
| `R05.receipt_unsequenced` | manual_review | needs_human_review | administrative_reviewer | none | two (order_receipt, order) |
| `R05.receipt_failed_provenance` | manual_review | needs_human_review | administrative_reviewer | none | one (order_receipt) |
| `R05.receipt_restricted` | restricted | needs_information | authorization_coordinator | none | one (order_receipt) |
| `R05.receipt_unreadable` | unreadable | needs_information | authorization_coordinator | none | one (order_receipt) |
| `R05.no_usable_receipt` | missing | needs_information | authorization_coordinator | none | none |
| `R05.order_receipt_missing` | missing | needs_information | authorization_coordinator | none | one (order) |
| `R05.no_usable_order` | missing | needs_information | authorization_coordinator | none | none |
| `R06.clinical_review` | manual_review | none | qualified_clinical_reviewer | none | none |
| `R07.lcmp_stated_by_case` | manual_review | needs_human_review | administrative_reviewer | none | none |
| `R07.lcmp_stated_by_encounter` | manual_review | needs_human_review | administrative_reviewer | none | one (encounter) |
| `R08.pack_id_differs` | conflict | scope_hold | administrative_reviewer | none | none |
| `R08.assessment_date_unsupported` | conflict | scope_hold | administrative_reviewer | none | none |
| `R08.pack_unreviewed` | missing | scope_hold | administrative_reviewer | none | none |
| `R08.pack_unsourced` | missing | scope_hold | administrative_reviewer | none | none |
| `R09.hash_mismatch` | conflict | needs_human_review | administrative_reviewer | none | one (order, encounter, order_receipt, supplier_status, supporting_note) |
| `R09.kind_mismatch` | conflict | needs_human_review | administrative_reviewer | none | one (order, encounter, order_receipt, supplier_status, supporting_note) |
| `R09.locator_unresolved` | conflict | needs_human_review | administrative_reviewer | none | one (order, encounter, order_receipt, supplier_status, supporting_note) |
| `R09.access_restricted` | restricted | needs_information | authorization_coordinator | none | one (order, encounter, order_receipt, supplier_status, supporting_note) |
| `R09.access_unreadable` | unreadable | needs_information | authorization_coordinator | none | one (order, encounter, order_receipt, supplier_status, supporting_note) |
| `R09.mime_unsupported` | unreadable | needs_information | authorization_coordinator | none | one (order, encounter, order_receipt, supplier_status, supporting_note) |
| `R09.body_invalid` | unreadable | needs_information | authorization_coordinator | none | one (order, encounter, order_receipt, supplier_status, supporting_note) |
| `R10.pure_assessment` | not_applicable | none | administrative_reviewer | none | none |

### Version 2 lab conventions

The pack states each convention in full. Compared with version 1:

| Convention | Version 2 change |
| --- | --- |
| C01, C02, C03 | Unchanged |
| C04 | Adds that the LCMP conditions never suppress another held R04 condition |
| C05 | Adopts complete condition sets and per-condition routing (D2); cites only current usable documents |
| C06 | Closes two gaps: both span ends are included, and a receipt at the same instant as the stated order timestamp is not sequenced |
| C07 | Separates a finding's own `documentRefs` from condition-level refs (below) |
| C08 | New: supersession as trusted registry metadata (D5) |
| C09 | New: candidates, quantifiers and the R03 and R05 interpretations |

C01 to C09 are lab conventions for repeatable fixtures, not CMS requirements
or legal interpretations. R03's basis becomes `source_and_lab` because its
per-order check rests on C09.

**C07 as amended.** A finding's `documentRefs` (an oracle's
`affectedDocuments`) name the documents it concerns but cannot cite through
facts. R02 names every quarantined version. R09 names every version with an R09
condition. R01, R03, R04 and R05 name the documents of their held restricted,
unreadable and failed-provenance conditions whose status is the finding's
status. Any other finding names none. Condition-level `documentRefs` follow
each key's declaration instead, and may name a usable version the finding also
cites. A missing-element condition therefore names its order while the parent
`documentRefs` stays empty. A quarantined version appears only in the
quarantine list, the superseded list and R02, and only R02 and R09 name a
superseded version.

### Candidates and quantifiers (C09)

| Term | Definition |
| --- | --- |
| Current | No applied registry relationship supersedes the version (C08) |
| Usable | Not quarantined and no R09 condition |
| Final | The body `status` is `final`. Only R04 requires final documents; drafts are usable for R01, R03, R05 and R07 |
| Candidate | When no current usable document of a kind exists (for R04, no final current usable document), each current, non-quarantined version of that kind with an R09 condition. A quarantined version is never a candidate |
| Only candidate | No current usable document of the kind exists (for R04, no final one), so the candidates' restricted, unreadable or failed-provenance conditions explain the gap. When such a document exists, other versions of that kind yield no candidate condition in that rule (R09 still reports them) |
| All relevant documents | Every current usable document of the rule's kinds, final or draft as the rule requires |

- R03 and R04 never report an absence (`no_usable_order`,
  `no_usable_encounter`) while a candidate explains the gap.
- R04 applies candidates whenever no final current usable document of the
  kind exists. A usable draft encounter beside a restricted encounter therefore
  yields both `R04.encounter_restricted` (which sets the status) and
  `R04.encounter_not_final`; the restricted version, which may be the final
  one, is never hidden.
- R09 gives each non-quarantined version only its first applicable condition,
  in the order `access_restricted`, `hash_mismatch`, `access_unreadable`,
  `mime_unsupported`, `body_invalid`, `kind_mismatch`, `locator_unresolved`.
  R02 alone reports versions it quarantines.
- R03 checks every current usable order separately and never combines
  elements across orders. Drafts are checked; R04 gates on final status. Where
  a name or identifier is permitted, either one satisfies the element.
- R05 is order-centred. Every current usable order needs at least one linked
  receipt (current, usable, referencing that exact order version, stating a
  receipt time) that follows it under C06, and every linked receipt is
  sequenced, so a good receipt never hides a conflicting or ambiguous one.
  A receipt with no receipt time, or one that references another version, links
  to nothing. An unlinked receipt satisfies no order but is still classified by
  R02 and R09 and cited under C05. `R05.no_usable_receipt` covers the cases with
  no usable receipt and no candidate (F02, F08b). A restricted, unreadable or
  failed-provenance receipt is a candidate only when no usable receipt exists,
  and no link is read from it.
- Two different stated non-null values disagree. A value beside `null` is not
  a disagreement; where `null` is an allowed unknown, the document with `null`
  gets its own missing condition.
- R01 excludes a superseded version only under a trusted C08 relationship.

### Quarantine by version (D3)

Quarantine applies to one exact version. Another version of the same document
ID is assessed normally. `pa.assessment-result.v3` adds
`quarantinedDocuments: DocumentRef[]`; the historical `pa.assessment-result.v2`
with `quarantinedDocumentIds` is unchanged. A quarantined version appears only
in the quarantine list, the superseded list and R02, by reference (and, in R02,
binding basis) only. No other finding, condition, fact or packet names it. A
superseded target is listed in `supersededDocuments` whether or not it is also
quarantined, because the relationship is metadata (C08). Regression vectors: a quarantined older version with a usable
newer version, the reverse, and an unrelated usable document in each.

### Failed supplier provenance (D4)

R01 outcomes are, in order: `conflict`, `manual_review`, `restricted`,
`unreadable`, `missing`, `pass`. Every non-pass outcome is `scope_hold`.
`R01.supplier_record_failed_provenance` (administrative reviewer) holds only
when no current usable supplier record with the case's
`supplierStatusEvidenceId` exists. Its unverified values are never used. R09
reports the same version separately as a conflict.

### Supersession (C08, D5)

**Relation shape.** The relationship is the `supersedes` reference in a
version's `pa.document.v1` metadata. That metadata is authored by the caller,
pinned with the fixture manifest and reviewed. A version supersedes at most one
target, an earlier version of its own document ID; several versions may
supersede the same target. An edge is (superseded ref, superseding ref), so the
complete relation set is the set of non-null `supersedes` references across the
supplied metadata. It cannot hold duplicates: when any
`duplicate_document_version` holds, no relationship is checked or applied,
because edges are ill-defined (below). Both endpoints are validated metadata
references. A body never creates, changes or cancels a relationship, and no
relationship is inferred from document text, a model response, a filename or
confidence.

**Integrity.** The graph is built from the complete supplied snapshot, so it is
independent of input order. This is not arrival-order recovery or audit
history (S4). Lineage is checked for every edge:

- a reference to another document ID is rejected with
  `supersession_cross_document`, so a supplier record with another ID can
  never displace the case's evidence record. A reference to a later or equal
  version of the same ID is already invalid metadata
  (`document_metadata_invalid`).

For every edge whose target is supplied:

- different kinds are rejected with `supersession_cross_kind`;
- endpoints whose metadata subjects differ from each other or from the case
  subject are rejected with `supersession_cross_subject`. This is the
  unauthorized-assertion reason; supplier status records, which have no
  subject, may supersede each other.

Because every edge points to a strictly earlier version, no cycle can form
from this metadata. `supersession_cycle` stays in the frozen grammar from
the version 2 decision review and is not reachable with v2 metadata.

Each rejection is a `snapshot_integrity` rejection with no partial
assessment. An edge whose target is not supplied has no effect and is not
checked. That is partial snapshot evidence only, never proof of the SPEC's
full F13 requirement, and the checks repeat when the target arrives (S4).

**Effect.** An applied edge makes its target superseded. The target is listed
in `supersededDocuments` (also when it is quarantined), contributes no facts, is never cited and is never a
candidate for R01 or R03 to R07. A superseder that is restricted, unreadable,
failed provenance or quarantined on its verified body does not revoke the
edge. Older evidence is never silently made current again; the superseder's
own condition is the blocker. R02 and R09 still classify every supplied
version, so a superseded restricted version still blocks this pure snapshot
through R09. This conservative choice is a recorded limitation until S4 designs
recovery; a later vector demonstrates the older-unusable, newer-usable case.

### Explicit input rejection (D6)

`pa.assessment-outcome.v3` is a discriminated union: `outcome: "assessed"`
with a `pa.assessment-result.v3`, or `outcome: "rejected"` with a
`pa.input-rejection.v1` `{ stage, reasons }`. A rejection carries no state,
findings, facts or partial result.

The stages are checked in order, and only the first failing stage is reported:

| Stage | Owner | Reason codes |
| --- | --- | --- |
| `input_boundary` | Fixture or ingestion loader, before any payload is parsed | `document_count_exceeded`, `path_outside_root`, `document_size_exceeded` |
| `schema` | Pure domain | `case_invalid`, `document_metadata_invalid`, `policy_pack_invalid`, `policy_pack_incomplete`, `assessment_date_invalid`, `assessment_date_mismatch` |
| `snapshot_integrity` | Pure domain | `duplicate_document_version`, `restricted_document_has_bytes`, `document_bytes_missing`, `supersession_cross_document`, `supersession_cross_kind`, `supersession_cross_subject`, `supersession_cycle` |

Only the fixture loader produces `path_outside_root`. The pure domain accepts
bytes and metadata and gains no filesystem, traversal or symlink capability.
Sharing the outcome envelope does not make the loader part of assessment
authority. A document body that fails to parse is never a rejection; it is
R09 `body_invalid`.

**Reasons.** Each reason is `{ code, documentRef, path }`.

- `documentRef` is the document's `{ documentId, version }`, or `null` when
  the reason concerns no single document or when metadata has not been
  parsed. For invalid metadata it is set only when both `documentId` and
  `version` parse; otherwise it is `null`.
- `path` is a logical input pointer into `{ case, assessmentDate, policyPack,
  documents }`, or `null`. A document is addressed by its slot name: in
  fixtures, the metadata sidecar name without `.meta.json`, such as
  `/documents/f01-order.v1/metadata`. A path never echoes a host path or
  source text.
- Reasons are unique and in canonical order: code, then `documentRef`
  (`null` first, then document ID and version as for conditions), then `path`
  (`null` first). Text compares by UTF-16 code units and versions numerically.
- Each code has one frozen shape, given below and exported as
  `REJECTION_REASON_SHAPES`; `InputRejection` rejects any other reference rule
  or path.

| Code | One reason per | `documentRef` | `path` |
| --- | --- | --- | --- |
| `document_count_exceeded` | Input | `null` | `/documents` |
| `path_outside_root` | Input, however many paths escape | `null` | `null` |
| `document_size_exceeded` | Oversized payload | `null` | `/documents/<slot>/payload` |
| `case_invalid` | Input | `null` | `/case` |
| `document_metadata_invalid` | Invalid sidecar | Parsed ref or `null` | `/documents/<slot>/metadata` |
| `policy_pack_invalid` | Input (any pack that is not a valid `pa.policy-pack.v2`, including a v1 pack) | `null` | `/policyPack` |
| `policy_pack_incomplete` | Input (a valid pack that lacks one of R01 to R10) | `null` | `/policyPack/rules` |
| `assessment_date_invalid` | Input (argument not an ISO date) | `null` | `/assessmentDate` |
| `assessment_date_mismatch` | Input (argument differs from a valid case's date) | `null` | `/assessmentDate` |
| `duplicate_document_version` | Slot sharing a ref with another slot | The ref | `/documents/<slot>/metadata` |
| `restricted_document_has_bytes` | Slot | The ref | `/documents/<slot>/payload` |
| `document_bytes_missing` | Non-restricted slot with no payload | The ref | `/documents/<slot>/payload` |
| `supersession_cross_document`, `supersession_cross_kind`, `supersession_cross_subject` | Superseding slot | Superseding ref | `/documents/<slot>/metadata/supersedes` |
| `supersession_cycle` | Slot on a cycle (not reachable with v2 metadata) | Its ref | `/documents/<slot>/metadata/supersedes` |

**Input-boundary precedence.** The loader counts supplied document versions
first, before expanding recipes, hashing or reading payloads. If the count
exceeds the limit, the rejection holds only `document_count_exceeded`. Otherwise
it checks every path and every payload length and reports all
`path_outside_root` and `document_size_exceeded` reasons together. Schema
reasons are likewise reported together. `assessment_date_mismatch` is checked
only when the argument and the case are both valid. Within snapshot integrity,
`duplicate_document_version`, `restricted_document_has_bytes` and
`document_bytes_missing` are always checked, while the supersession checks are
skipped whenever any `duplicate_document_version` holds. For combined-invalid
inputs, the expected reason set is the complete set of the first failing stage
under these rules:

- 51 documents with one oversized payload give only `document_count_exceeded`.
- An escaping path and an oversized payload give both of their reasons.
- A padded case name with invalid metadata gives `case_invalid` and
  `document_metadata_invalid`. Snapshot reasons are not reported.
- Two slots with the same document version, plus a restricted slot with
  bytes, plus an edge to another document ID give two
  `duplicate_document_version` reasons and one `restricted_document_has_bytes`
  reason. The cross-document edge is not reported.

These limits are bounded validation, not a new aggregate byte limit. A
lexical path check alone does not prove safe loading: the loader tests in
`evals/src/v2/loader.test.ts` exercise the real loader with in-root symlinks
and outside sentinels and show that no outside payload is opened. Ingestion enforcement remains S4.

**F26 conventions.** The count is every supplied document version, current or
superseded: 50 is allowed and 51 rejected. Size is the raw source payload in
bytes (not characters), excluding metadata sidecars and manifests: 1,048,576
bytes is allowed and 1,048,577 rejected.

**F15 conventions.** The unreviewed branch uses the negative policy input
`evals/suites/policy-v2/policy-inputs/lab-k0823-jd-20261018-unreviewed.json`.
Its bytes are the v2 pack bytes with only two values changed: `packId` is
`lab-k0823-jd-20261018-v2-unreviewed` and `reviewedAsOf` is `null`. Rules,
supported dates, title, sources and conventions are identical, so every other
rule's expected outcome is as with the reviewed pack. `evals/src/frozen-v2.ts`
pins it and a test checks the derivation; the scope batch consumes it frozen. The
case's `policyPackId` equals that ID, so only `R08.pack_unreviewed` holds.
`R08.pack_unsourced` is reachable only for a pack whose every rule is
lab-based: any other rule must cite a listed source, so an unsourced variant of
this pack is `policy_pack_invalid` and no F15 vector can show that condition.
The unsupported-date branch uses the reviewed v2 pack with case date and
argument both 2026-10-19 (`R08.assessment_date_unsupported`); that date is not
added to the pack.

### Oracle format `pa.oracle.v3`

The example is abbreviated: an assessed expectation lists one finding per rule
(R01 to R10), and only R03 is shown.

```json
{
  "schemaVersion": "pa.oracle.v3",
  "fixtureId": "F03a",
  "fixtureManifestSha256": "<SHA-256 of manifest.json>",
  "policyInput": { "packId": "lab-k0823-jd-20261018-v2", "sha256": "<SHA-256 of the pack bytes>" },
  "specReferences": {
    "fixtureRow": "F03",
    "rules": ["R03"],
    "sections": ["Administrative requirements", "Critical fixture suite"],
    "decisions": ["D2"],
    "conventions": ["C05", "C07", "C09"],
    "sources": ["S08", "S09"]
  },
  "authoringNote": "Why each expected status, condition, citation and document follows from the SPEC, the pack and the cited sources.",
  "expectation": {
    "outcome": "assessed",
    "state": "needs_information",
    "findings": [
      {
        "ruleId": "R03",
        "status": "missing",
        "responsibleRole": "authorization_coordinator",
        "affectedDocuments": [],
        "citations": [{ "documentId": "f03a-order", "documentVersion": 1, "locator": "/orderDate" }],
        "conditions": [
          { "conditionKey": "R03.element_missing", "field": "element.signature", "documents": [{ "documentId": "f03a-order", "version": 1 }] }
        ]
      }
    ],
    "quarantinedDocuments": [],
    "supersededDocuments": [],
    "clinicalReviewRequired": true,
    "exactText": [{ "documentId": "f03a-order", "documentVersion": 1, "locator": "/beneficiary/name", "originalText": "Name as written" }],
    "deferredExpectations": [{ "stage": "S4", "statement": "Arrival-order recovery is not exercised by this snapshot." }]
  }
}
```

- `specReferences` and `authoringNote` are required. `specReferences` names
  the SPEC fixture row, rules, SPEC sections, version 2 decisions (`D1` to `D6`),
  lab conventions (`C01` to `C09`) and research sources (the pack's
  `sourceRefs`, S06 to S12 and S14) that justify the expectation;
  `authoringNote` is the original rationale for every expected value. Both are
  checked by independent oracle review and never compared with a result. They
  replace `pa.oracle.v2`'s `specReferences` (whose `slicePlanDecisions` become
  `decisions` and `conventions`) and `authoringNote`.
- Findings, citations, affected documents, conditions and both document lists
  compare as sets. Each condition's routing comes from the pack and is not
  repeated. An oracle condition's `documents` is the contract's
  `FindingCondition.documentRefs`, and `affectedDocuments` is
  `FindingV3.documentRefs`, following the v2 oracle naming.
- `clinicalReviewRequired` is `true` exactly when R06 is `manual_review`
  (always, in version 2).
- `exactText` is optional. Each entry requires the cited fact at that locator
  to carry exactly that `originalText`.
- `deferredExpectations` is optional. It names behavior the vector does not
  prove and the stage that will. It is never compared and never counted as
  passed.
- A rejected expectation is `{ "outcome": "rejected", "stage": ..., "reasons":
  [...] }` with the reasons of `pa.input-rejection.v1` in their frozen shapes,
  compared exactly.
- An expected rejection is distinct from a harness refusal. A fixture expected
  to be rejected is outside the false-ready denominator. A rejection where
  assessment was expected is a mismatch, never a false-ready.

### Manifest format `pa.fixture-manifest.v2`

```json
{
  "schemaVersion": "pa.fixture-manifest.v2",
  "fixtureId": "F26b",
  "specFixtureRow": "F26",
  "title": "Oversized source payload",
  "scenario": "Original synthetic scenario statement.",
  "syntheticProvenance": "Original synthetic fixture statement.",
  "assessmentDate": "2026-10-18",
  "policyInput": { "path": "policy-packs/lab-k0823-jd-20261018-v2.json", "sha256": "<pack SHA-256>" },
  "coverage": ["F26", "D6.input_boundary.document_size_exceeded"],
  "files": [{ "path": "case.json", "sha256": "<SHA-256>" }],
  "pathAttempts": [{ "slot": "outside.v1", "path": "../outside.json" }],
  "recipes": []
}
```

- `assessmentDate` is the explicit argument given to the assessment.
- `policyInput.path` is repository-relative: the reviewed pack under
  `policy-packs/`, or a negative input under
  `evals/suites/policy-v2/policy-inputs/`. Its hash must equal a pin in the
  batch (`policyPack` or `policyInputs`).
- `coverage` lists the SPEC rows, decisions and condition keys the fixture
  exercises, for coverage reporting. Exact references and rationale are in the
  oracle's `specReferences` and `authoringNote`.
- `pathAttempts` (optional, loader tests only) lists slots whose path is
  deliberately outside the fixture root. They are test data inside a valid
  manifest, never actual escaping `files` entries. The loader must reject them
  without opening them.
- `recipes` (optional) generate payloads and metadata that are too large or
  too repetitive to commit (below).

### Fixture layout

Every v2 batch shares the suite root `evals/suites/policy-v2/` (the batch's
`root`), including the scope and boundary batches:

| Path under the root | Contents |
| --- | --- |
| `fixtures/<fixtureId>/manifest.json` | The fixture manifest |
| `fixtures/<fixtureId>/case.json` | The `pa.case.v2` input |
| `fixtures/<fixtureId>/documents/<slot>.meta.json` | One `pa.document.v1` metadata sidecar per supplied version |
| `fixtures/<fixtureId>/documents/<slot>.json` | That slot's raw source payload |
| `fixtures/<fixtureId>/documents/<name>.template.json` | A recipe template, never a slot |
| `oracles/<fixtureId>.json` | The `pa.oracle.v3` oracle |
| `policy-inputs/<name>.json` | Negative policy inputs, pinned in the batch |

- A slot name is unique within the fixture, matches
  `[A-Za-z0-9][A-Za-z0-9._-]*` and is conventionally `<documentId>.v<version>`.
  A slot name never ends in `.meta` or `.template`.
  A deliberate duplicate-version vector gives the other slots a distinguishing
  suffix, such as `<documentId>.v<version>.dup1`. Payload and metadata pair by
  slot name. The loader never derives or checks document identity from the
  name; identity comes only from the metadata.
- A slot whose metadata is `restricted` has no payload file. A non-restricted
  slot without one is a `document_bytes_missing` input; a restricted slot with
  one is `restricted_document_has_bytes`. These are trusted test inputs that the
  assessment rejects.
- A payload file with no metadata sidecar (an orphan) is a malformed fixture:
  the loader refuses the fixture and nothing is assessed. Every file is listed
  in `files` with its SHA-256, except recipe outputs, which are pinned in their
  recipe.
- A fixture ID belongs to exactly one batch. The union rejects a duplicate.

### Recipe grammar

A recipe is closed data, never a script. It reads only templates listed in the
fixture's `files` under `documents/`, or the output of an earlier recipe in the
same fixture, and writes only its pinned outputs. It has no imports,
environment access, arbitrary paths or policy evaluation. Recipes run in array
order, so a recipe may consume only committed templates and outputs of recipes
before it.

```json
{ "recipe": "pad", "template": "documents/f26-note.template.json", "placeholder": "@@PAD@@", "fill": "é", "targetBytes": 1048577, "output": "documents/f26-note.v1.json", "sha256": "<SHA-256 of the output>" }
```

`pad` replaces the single occurrence of `placeholder` (inside a JSON string
value) with `fill` repeated *n* times. *n* is chosen so the UTF-8 output is
exactly `targetBytes`. `fill` is 1 to 8 characters, with no quote, backslash or
control character. A target is rejected when it is impossible: smaller than the
template without its placeholder, or not reachable by whole repetitions of
`fill`'s byte length. Multibyte fills prove the limit counts bytes. The output
is the payload of the slot named by its path, whose metadata sidecar is
committed.

```json
{ "recipe": "replicate", "payload": "documents/f26-note.payload.template.json", "metadataTemplate": "documents/f26-note.meta.template.json", "placeholder": "@@N@@", "count": 51, "width": 2, "outputs": [{ "slot": "f26-note-01.v1", "metadataSha256": "<SHA-256>" }] }
```

`replicate` supplies one payload byte-for-byte as the payload of every copy:
a committed template, as here, or an earlier recipe's output. Every copy
therefore has the same `contentHash`, written literally in the metadata
template. It substitutes the 1-based index, zero-padded to `width`, for
`placeholder` in the metadata template only. Each output must parse as
`pa.document.v1` with a distinct document ID. Its slot is the rendered
document ID plus `.v<version>`, and `outputs` pins every copy in index order.
Replicated slots count toward the document count like any other slot.

Bounds: `count` is 1 to 64 and `targetBytes` is at most 2,097,152. One
fixture's recipes produce at most 4,194,304 bytes in total, counting every
generated output and, for each replicated copy, its metadata and the payload
bytes supplied for it. Every output hash is pinned, and a mismatch refuses the
fixture. Generated outputs are never committed.

### Batch extension interface

Each frozen batch is hash data only:

```ts
interface FrozenBatch {
  batchId: string; // for example 'policy-v2-core'
  root: string; // 'evals/suites/policy-v2' for every v2 batch
  formatVersions: { manifest: 'pa.fixture-manifest.v2'; oracle: 'pa.oracle.v3' };
  policyPack: { packId: string; path: string; sha256: string };
  policyInputs: { packId: string; path: string; sha256: string }[]; // negative inputs such as F15's unreviewed pack
  fixtures: Record<string, { manifestSha256: string; oracleSha256: string }>;
}
```

`evals/src/frozen-v2.ts` holds the core batch. It already pins the candidate
pack and the F15 negative input and registers no fixtures of its own.
`evals/src/frozen-v2-scope.ts` holds the scope batch, which references the
same pack and inputs. The loader validates their union and refuses:

- a duplicate fixture ID;
- one path or pack ID pinned to two hashes, or one pack ID at two paths;
- different roots or incompatible format versions;
- a fixture directory without a pin, or a pin without a directory.

A pinned hash proves only that the bytes are the reviewed bytes, never that an
expectation is semantically correct. The version 2 assessment consumes the validated union with
no per-batch logic.

### Runtime migration and legacy support

- The legacy contracts stay exported and tested unchanged. Version 1 bytes,
  validators, `frozen.ts` and the rules-only gate stay as historical evidence
  and compatibility checks.
- Runtime decision: keep the version 1 assessment entry point under its existing gate, beside a
  separate version 2 entry point that accepts only `pa.case.v2`, the exact
  parsers and `pa.policy-pack.v2`. Neither entry point accepts the other's
  formats, and neither switches on `schemaVersion`. Retiring the v1 runtime
  needs a separate decision; retiring the v1 evaluation inventory
  alone does not decide what the domain accepts.
- Any authoring helper only generates bytes, hashes and mechanical citation
  formatting from an independently authored selection list. It never decides
  usability, binding, supersession, chronology, statuses or conditions.

### Validation boundaries

Structural validation, assessment comparison and persisted workflow checks have
separate responsibilities. `pnpm test:oracles:v2` checks schemas, fixture and
oracle integrity, recipe pins and declared expectations. The version 2
assessment evaluation compares deterministic results with the frozen oracles.
Arrival order, recovery and disposition of superseded unusable versions belong
to the durable workflow (S4).

## Version 2 structural validation

This is an implementation addendum, outside the frozen version 2 specification
above. It changed that specification only by the N3 sentence in the slot name
bullet of "Fixture layout". The readings below were approved in review.

### Command

`pnpm test:oracles:v2` (Vitest project `oracles-v2`, entry
`evals/src/v2/oracles.check.ts`) validates every batch registered in
`evals/src/v2-batches.ts`. It checks the batch pins, the union of all batches
and the suite inventory, then loads every fixture, checks its oracle against the
loader result and the pinned pack, and finally runs a separately labelled
recipe pin audit. It computes no assessment, no false-ready measurement and no
policy outcome. Any problem fails the command with a nonzero exit, and the
report lists each problem without echoing source content. It needs neither a
build nor a database. The structural and tamper tests under `evals/src/v2/`
run in `pnpm test`.

| Module | Responsibility |
| --- | --- |
| `schemas.ts` | Strict schemas for `pa.fixture-manifest.v2`, `pa.oracle.v3`, `FrozenBatch` and the recipes, with the input and recipe limits |
| `json-scan.ts` | A strict JSON scanner that keeps each scalar's raw token and each string value's span |
| `recipes.ts` | The `pad` and `replicate` recipes, their static graph check and the generated-byte budget |
| `loader.ts` | The count-first fixture loader, the only producer of `input_boundary` rejections, and the per-fixture recipe audit |
| `batches.ts` | Batch pins, union consistency, suite inventory and the per-fixture file trust audit |
| `oracle-check.ts` | Oracle identity, pins and structural consistency with the loader result and the pack |
| `command.ts` | The command function `runOraclesV2` and its report |

`evals/src/v2-batches.ts` is a data-only registry: a later batch task appends
one import and one array entry. It imports only `./frozen-v2.js` and
`./frozen-v2-<name>.js` batch tables. The v2 modules import no assessment code
(`@pa/domain`), no app code and no legacy evaluator module; ESLint and
`independence.test.ts` enforce this.

### Refusal and rejection

- A refusal is malformed or tampered evaluator data: a manifest, oracle, batch
  or pin that fails its schema or hash, an orphan payload, a reserved slot name,
  an unlisted or missing file or a recipe that fails. An unexpected file
  system error, such as a permission error, is also a refusal, naming only the
  suite-relative path and the error code. Refusals are content-free problems,
  and the command fails.
- Only the loader produces an `input_boundary` rejection, in the frozen
  `pa.input-rejection.v1` envelope. It counts slots first and rejects 51 or
  more with `document_count_exceeded` alone, before resolving any path,
  measuring any size or reading any payload. Otherwise it resolves every listed
  file and path attempt under the canonical fixture root, measures every
  payload (recipe outputs from their declared sizes, without expansion) and
  reports every `document_size_exceeded` reason in canonical reason order (by
  payload path, UTF-16 code units) followed by at most one `path_outside_root`.
  A dangling link or a symbolic link loop counts as an escape. An outside path
  is never opened. Only after that does it read bytes, check manifest hashes
  and expand recipes.
- `schema` and `snapshot_integrity` rejections belong to the domain. The
  validator checks such oracle expectations only structurally: the frozen
  reason shapes and order, that each named slot is supplied, and that each
  document reference agrees with that slot's metadata. A
  `document_metadata_invalid` reference is set exactly when the sidecar's
  written `documentId` and `version` both parse, and then equals them.
- An assessed oracle is checked against declared data only: its conditions
  against the pack's declared keys, qualifiers, arity and document kinds (a
  `two` key names one document of each declared kind), the status, role and
  state against the pack's outcome order, and C07 references from the declared
  conditions. R02's condition documents equal the quarantine list, and no
  version is named by two R09 conditions; which R09 condition applies is not
  decided. The validator never decides a status or
  condition from source content. Citations must point to an available,
  hash-matching, supported and valid payload, at one of the rule's evidence
  fields for that document kind, with a non-null value. Exact text is compared
  with the raw source token.

### Approved readings

1. The manifest `assessmentDate` is any string. It is passed to the domain
   verbatim; its validity is the domain's schema stage.
2. C07 parent references are checked from declared conditions only. R02 names
   its quarantine list. R09 names the union of its condition documents. R01,
   R03, R04 and R05 name the documents of held restricted, unreadable and
   `*_failed_provenance` conditions whose outcome status equals the finding
   status. Any other rule names none.
3. Fixture IDs that are equal under case folding are refused across the union.
4. `pad` with zero repetitions is allowed.
5. A control character is a Unicode `Cc` character.
6. A path attempt is a supplied, counted slot resolved relative to its fixture
   directory, and needs no metadata. It is refused if its slot collides with
   another slot name or if it resolves inside the fixture root.
7. Negative policy inputs are trusted by hash. If one parses as a pack, its
   `packId` must match the pin; an invalid input is accepted as bytes. An
   assessed oracle needs a policy input that parses.
8. The trust audit refuses symbolic links and other non-regular files in a
   committed fixture. The loader's symbolic link behavior is proven on
   temporary trees.
9. Nonzero exits are proven by unit tests of `runOraclesV2` and by one manual
   run against a tampered temporary clone.

### Recipe readings

- The `replicate` `width` is a minimum zero-padding width. Width 9 with one
  copy and width 1 with 51 distinctly named copies are both valid.
- Every occurrence of the placeholder in a `replicate` metadata template is
  replaced.
- `pad` counts the characters of `fill` as Unicode scalar values.
- The fixture ID is a single safe path segment. The naming convention
  `^F[0-9]{2}(?:[a-z][a-z0-9]{0,7})?$` is not enforced. The directory name,
  batch key, manifest and oracle fixture IDs must agree, and the oracle's
  `specReferences.fixtureRow` must equal the manifest's `specFixtureRow`.
- The loader path stays strictly count-first. The separately labelled recipe
  pin audit expands every recipe, including those of count- or size-rejected
  fixtures.

### Ratified exception to the frozen grammar

The frozen grammar lets a recipe read "the output of an earlier recipe". As a
ratified exception, a `replicate` payload may
not be another `replicate` recipe's generated metadata, because that payload's
size is unknown before expansion and so could not be measured by the
count-first loader. A `replicate` payload can still be a listed template or an
earlier `pad` output.

### Implementation readings

These follow from the grammar and are recorded for review.

- `pad` counts placeholder occurrences including overlapping ones, so `@@` in
  `@@@` is two occurrences and is refused.
- `replicate` substitutes with split and join semantics, so occurrences are
  non-overlapping.

### Coverage and gaps

- The core batch registers no fixture of its own; the batches below supply the
  committed fixtures. The tests also prove every check on synthetic fixtures
  built in temporary directories.
- The command runs no assessment. Domain rejections are checked as declared
  expectations; runtime loading belongs to the version 2 assessment.
- The checks were exercised on macOS only.

## Migrated scenarios and decision regressions

This is a data addendum, outside the frozen version 2 specification and the
structural validation addendum above. Batch `policy-v2-migrated-decisions` is the hash-only
table `MIGRATED_DECISIONS_BATCH` in `evals/src/frozen-v2-migrated.ts`,
registered second in `evals/src/v2-batches.ts`. It pins the same reviewed v2
pack as the core batch and no negative policy input. The catalogue was approved
with corrections and split into two parts after an independent catalogue
review. Every expected state, status, condition, role,
reference and citation was written by hand from the SPEC, the v2 pack and
conventions C01 to C09. No assessment engine, harness output or domain test was
run or read to obtain them. `pnpm test:oracles:v2` checks this batch only
structurally; it is not a proof of policy completeness.

### Fixtures

The batch holds 21 fixtures: 19 assessed expectations and 2 rejected
expectations. The eight originals keep their legacy IDs. Each decision
regression is `F<row>x<n>`, named after the SPEC row it exercises.

| Fixture | SPEC row | What it isolates | Expected |
| --- | --- | --- | --- |
| F01 | F01 | Migrated supported packet | `ready_for_review` |
| F02 | F02 | Migrated: no order and no receipt record | `needs_information`; R03 and R04 `no_usable_order`, R05 `no_usable_receipt` |
| F06 | F06 | Migrated: same-day encounter and order without times | `needs_human_review`; R04 `same_day_unsequenced` |
| F08a | F08 | Migrated: attachment filed under another subject | `needs_human_review`; R02 `metadata_subject`, quarantined by version |
| F08b | F08 | Migrated: only order states another beneficiary | `needs_human_review`; R02 `stated_identifier` and `stated_name`; R03, R04 and R05 absence |
| F22 | F22 | Migrated: broad checklist worksheet | `ready_for_review`; no blanket requirement |
| F23 | F23 | Migrated: LCMP stated by case and encounter | `needs_human_review`; both LCMP conditions in R04 and R07 |
| F25 | F25 | Migrated: order states the name only | `ready_for_review`; null identifier never cited |
| F01x1 | F01 | D1: padded description and diagnosis, quantity token `1.0` | `ready_for_review`; three `exactText` entries |
| F01x2 | F01 | D1: empty and blank encounter narratives and note text accepted | `ready_for_review`; no R09 condition |
| F01x3 | F01 | D1: empty and blank note titles | `needs_information`; R09 `body_invalid` for each note |
| F25x1 | F25 | D1: case name with surrounding spaces | rejected, `schema`: `case_invalid` |
| F25x2 | F25 | D1: blank case name and two blank provenance statements | rejected, `schema`: `case_invalid` and two `document_metadata_invalid` |
| F08x3 | F08 | D1: note name with a trailing space | `needs_human_review`; R02 `stated_name` |
| F14x1 | F14 | D2: two encounters disagree on the date | `needs_human_review`; R04 `encounters_disagree` |
| F14x2 | F14 | D2: several R03 and R04 conditions in one finding, with lower-priority routing | `needs_human_review`; three R03 and four R04 conditions |
| F03x1 | F03 | C09: complete order beside an order without signature metadata | `needs_information`; R03 `element_missing` (signature) for the second order only |
| F03x2 | F03 | C09 and D1: signer names differ by a trailing space | `needs_human_review`; R03 `orders_disagree` (signer name) |
| F14x3 | F14 | C09: draft order before the encounter beside a final order | `needs_human_review`; R03 disagreements, R04 pass |
| F26x1 | F26 | C09: second order without a qualifying receipt | `needs_human_review`; R05 `order_receipt_missing`, R09 `hash_mismatch` |
| F26x2 | F26 | C09 and C06: good, conflicting and unsequenced receipts for one order | `needs_human_review`; R05 `receipt_before_order` and `receipt_unsequenced` |

Each oracle's `authoringNote` gives the reason for every expected value.
Rejected oracles carry only the stage and reasons.

### Reserved identifiers

The catalogue decision reserves 37 decision and migration IDs across two
batches. The remaining 16 belong to the version decision batch (its own table,
batch and guide section),
not authored here: F08x1, F08x2, F10x1, F10x2, F13x1 to F13x11 and F08x4.
Authored fixture and oracle identities and inventories are disjoint across
batches; the frozen pack pin is shared by design. Exact ownership is
recorded, and these IDs, including case-folded equivalents, are excluded from
later allocations.

### Recorded reading

A rule cites evidence-field facts only from the documents it reads under C09.
R04 reads only final current usable documents, so it does not cite a draft's
status, date or practitioner identifier; F14x3's R04 finding cites the final
encounter and final order only. Explicit R04 draft diagnostic conditions, such
as `R04.order_not_final`, still name the draft in their references. This
reading changes no frozen byte.

### Migration of the eight originals

Every source payload and metadata sidecar was copied byte for byte from the
first-slice Git blobs to the same file name under
`evals/suites/policy-v2/fixtures/<ID>/documents/`. No original has a
restricted slot, so no payload is absent by design; F02 and F08b supply no
receipt record, as their scenarios state.

| Category | Change |
| --- | --- |
| Case | Exactly two byte substitutions: `"pa.case.v1"` to `"pa.case.v2"` (D1: the contract with a canonical `subjectName`) and `"lab-k0823-jd-20261018-v1"` to `"lab-k0823-jd-20261018-v2"` (R08: the case names the pack supplied). Every name is already canonical; nothing else changes |
| Manifest | New `pa.fixture-manifest.v2`: the v1 title and scenario unchanged, the v1 provenance statement unchanged as a prefix plus one migration sentence, assessment date 2026-10-18, the v2 pack path and hash, coverage, the new `case.json` hash and the preserved source hashes. The manifest excludes itself |
| Oracle | New `pa.oracle.v3`, written from the rules and not converted: `expectation.outcome`, condition tuples, exact-version quarantine and superseded lists, the v2 pack pin, references and rationale |
| Expected sets | States, statuses and roles are unchanged from v1. Every v2 oracle carries the R06 `clinical_review` and R10 `pure_assessment` tuples; the other v2 changes are listed below |

| Original | v1 and v2 state | v2 change in the expected set |
| --- | --- | --- |
| F01 | `ready_for_review` | No condition change; an S4 deferral notes that human acceptance is a separate action |
| F02 | `needs_information` | Tuples R03 `no_usable_order`, R04 `no_usable_order`, R05 `no_usable_receipt`; R01 cites no order code |
| F06 | `needs_human_review` | Tuple R04 `same_day_unsequenced` naming the encounter and order |
| F08a | `needs_human_review` | Quarantine by exact version (D3); R02 tuple `binding.metadata_subject` |
| F08b | `needs_human_review` | Quarantine by exact version; R02 tuples `binding.stated_identifier` and `binding.stated_name`; the three absence tuples of F02 |
| F22 | `ready_for_review` | Pin changes only |
| F23 | `needs_human_review` | R04 and R07 each carry `lcmp_stated_by_case` and `lcmp_stated_by_encounter` |
| F25 | `ready_for_review` | No condition or citation change; the null order identifier stays uncited (R02 five, R03 eight, as in v1) |

Preserved files (62), each with the same SHA-256 at the old path
`evals/fixtures/<ID>/<file>` and the new path
`evals/suites/policy-v2/fixtures/<ID>/<file>`:

| Fixture | Source or metadata file (same name under both roots) | SHA-256 (old and new) |
| --- | --- | --- |
| F01 | `documents/f01-encounter.v1.json` | `8b7d9b98edbb0bad09e100d009ce47fa3ab006582a55b0850814cae92be94e83` |
| F01 | `documents/f01-encounter.v1.meta.json` | `7c68c4afebcc1b942f89393867996407e70532799c186f1b9e5af00d7fbd240a` |
| F01 | `documents/f01-order.v1.json` | `60668dad9d3a1404bc577b652aaeefef03cf608df0ec40c7dba76d577505db76` |
| F01 | `documents/f01-order.v1.meta.json` | `35e704b804d1e76ae786bb4450bf9aab1cb946021c5c8aec9979847d894d9028` |
| F01 | `documents/f01-receipt.v1.json` | `73a1163ce890281946ed877ce262fa30df4a648f93d0f8d239babfe6d99edc59` |
| F01 | `documents/f01-receipt.v1.meta.json` | `da2563035a8f0e0c3c24b21c679f5f402eca58d5d0a634c140ee7c0761222357` |
| F01 | `documents/f01-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F01 | `documents/f01-supplier-status.v1.meta.json` | `6a73a83fce78e39da86ab3f7935820a82b1375f3767aa2082706f1b981691372` |
| F02 | `documents/f02-encounter.v1.json` | `dcff0a7b8be7cf5e8147625d8413db010cc568dd6131c9f36d6e8713d1dad0ab` |
| F02 | `documents/f02-encounter.v1.meta.json` | `1757e4f45758de99b88f70b726e2be21a28d77c1235618f40e44b17a1d2a865d` |
| F02 | `documents/f02-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F02 | `documents/f02-supplier-status.v1.meta.json` | `5b2d0c0c089209e1f5a852311fb0235e3232a98794e19124d0bec2568e0eabe7` |
| F06 | `documents/f06-encounter.v1.json` | `05f79ef756bf86dc5f72f02f5c06730fc630b52551101671f60301d177048c5a` |
| F06 | `documents/f06-encounter.v1.meta.json` | `417df28f996fa90d3c47ee98980e37cc260520f14a2a329321ad8c4949df8df1` |
| F06 | `documents/f06-order.v1.json` | `71448d0d0f1ac1d41203107e75555956fc645406e665702d4a9a47295edf5535` |
| F06 | `documents/f06-order.v1.meta.json` | `f089a3294b404cb7e9f79f6cced8957e4a3cb49e0ea6781aa92a9158f5fd0de8` |
| F06 | `documents/f06-receipt.v1.json` | `ffad7e28bf61a48e655c18b4de71c0fcdc7e1d7eec5af913f517640d5d8352b1` |
| F06 | `documents/f06-receipt.v1.meta.json` | `d874a108701a694cbdd4bd9b2e8cdfcb6ee1e5e7a33b9f6b4f9dc550bc416a22` |
| F06 | `documents/f06-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F06 | `documents/f06-supplier-status.v1.meta.json` | `ff52ae9b86abaee463005387171b1038068310e6cbb4e042e0f57607d79c36c3` |
| F08a | `documents/f08a-attachment.v1.json` | `66680d7928cb697c22debb063307114156e71dc7a3180449382760cff7e1d44b` |
| F08a | `documents/f08a-attachment.v1.meta.json` | `73b58e69bfb6d78a04287daab16ad58ec9a0d475742ff7930a2c13a3637dfe5c` |
| F08a | `documents/f08a-encounter.v1.json` | `fe0255840aca7d70e88a5d9de9515b72d9ea6735324936a3e80ad67edf04ccc0` |
| F08a | `documents/f08a-encounter.v1.meta.json` | `21c9178edec94b5d9ea7f0966044eff785eb2ab2960689bfb4a56e66b39a5be4` |
| F08a | `documents/f08a-order.v1.json` | `df5fb4f09d2bf431f35a41f6b52a061eeeefff72e4af0b265cf42475332c16b6` |
| F08a | `documents/f08a-order.v1.meta.json` | `0e425ba742220230265d0553c1d7f90e738b90d16ff0feb141420b459bb8a8e5` |
| F08a | `documents/f08a-receipt.v1.json` | `2dbf5a9df61e5ef175da775fce1f759390c5ef9932c9ba2292077773c6410f82` |
| F08a | `documents/f08a-receipt.v1.meta.json` | `b96851e598890841252770c897bd8aa82089d06941ef11b48a5c19cd381582bd` |
| F08a | `documents/f08a-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F08a | `documents/f08a-supplier-status.v1.meta.json` | `3ca8fe25d8691157c7d5e8114681a0008c3a230f354541be11788b04fae6b7b0` |
| F08b | `documents/f08b-encounter.v1.json` | `4451da593f2890b8755025bef2c1174e325a9bb3d222b8f75df61a163eb26c60` |
| F08b | `documents/f08b-encounter.v1.meta.json` | `2eaeb6fa20fac1745c987e02fa85c47b8a90240d44af7af7f6f584c78b727f1a` |
| F08b | `documents/f08b-order.v1.json` | `8e22c454012918c6fe8290eb4cd250ff2dbb9ce9508295ce68a9554f84031e30` |
| F08b | `documents/f08b-order.v1.meta.json` | `84c0c6e1040978b3c11c806a323f86d0ea1cfd13e3d82f0bd00ae9cb7bb04460` |
| F08b | `documents/f08b-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F08b | `documents/f08b-supplier-status.v1.meta.json` | `6259ff004094f8b97ac4fc74be5a3eeb250dbbdcfce915922a4cb862d78e922e` |
| F22 | `documents/f22-encounter.v1.json` | `37debdde015c1a1050f69614e8d447996b4c8da4d56e457f0180f0ae73c37f41` |
| F22 | `documents/f22-encounter.v1.meta.json` | `06d84aa85ba650f592e8b71cbe3f62fb0f9df2674fecfa5e82ee0785f0923fd0` |
| F22 | `documents/f22-order.v1.json` | `33b49b0ae17fbdcb2d8deaccbc3dfabda36f03997d9345ee0a7dc7b7c4c8ad82` |
| F22 | `documents/f22-order.v1.meta.json` | `c05dadc483748347621773e623e65d225152445bd86f25362533c82b016e3cd5` |
| F22 | `documents/f22-receipt.v1.json` | `fe1d4a1bc1b0acd80856303c533e420f7e4917ea6d6efb51ecdb84e1f33c3d98` |
| F22 | `documents/f22-receipt.v1.meta.json` | `93de2397daacbe196ce3a767a0f0ab9f7a218a401b3fc5b538b5acc6db43b0e0` |
| F22 | `documents/f22-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F22 | `documents/f22-supplier-status.v1.meta.json` | `3c9770dc8a09dcd40b7b2c0471467ea0c3f2898b6f92cc6cff5e6db2b171192f` |
| F22 | `documents/f22-worksheet.v1.json` | `9cb535b82ac8b1ff9b691a14818dcbffe7f84146624faf34bc2edf81b9457bbd` |
| F22 | `documents/f22-worksheet.v1.meta.json` | `195ec520de8da3e159880e01f5bef846c82e4862ecfe91856b07cb082dfda34c` |
| F23 | `documents/f23-encounter.v1.json` | `610e957e41b0f49e4cbadfb6fecc7f5afbe678a73743f477810fbaf0e844f6e6` |
| F23 | `documents/f23-encounter.v1.meta.json` | `2ef3cdc7f44ecb2d2f9cf54abf2ceb2ee5b13c07f93f493bdad73b77ce2920df` |
| F23 | `documents/f23-order.v1.json` | `dffbe7d26e118ffc81ab12fa193abd41f329b37478258ced26442e12b0da1008` |
| F23 | `documents/f23-order.v1.meta.json` | `7734cfd023322d6596f57f58a4710698549d28d4c6e44a2e026d92886436b1aa` |
| F23 | `documents/f23-receipt.v1.json` | `a86dbb86c998d2fa1104dbcdf884ae9d51a43d8f0e5b9cb6c8f45772bdb886f9` |
| F23 | `documents/f23-receipt.v1.meta.json` | `82dce02da68f28a185a1cec4b2492bb887f06be055aeb3640eb73462a20fcc26` |
| F23 | `documents/f23-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F23 | `documents/f23-supplier-status.v1.meta.json` | `1a918b85da0e0b02d1bfc4089850aaf0f36d9cdc5d6a3478ac08d701a32315bf` |
| F25 | `documents/f25-encounter.v1.json` | `a34153d8cde2fcefa2fa7f3c28b88d9bdb9c8c3214c220697caf8cd1ef93eec6` |
| F25 | `documents/f25-encounter.v1.meta.json` | `864182b6d9d830bff50efcc2f8bffcfaae42cf540f7324873ba597deba962355` |
| F25 | `documents/f25-order.v1.json` | `d63efc409c64b6405599dc931e7dbdc235da7fb219b4902942faef8f8009628e` |
| F25 | `documents/f25-order.v1.meta.json` | `b6cd418c0a5bc0559137b5c424157f26c24b5e656fe010356b999075b2b520fa` |
| F25 | `documents/f25-receipt.v1.json` | `a926bcd2b7881f8adf1374f6e86d77256b739da212481bfc066803b32ed42296` |
| F25 | `documents/f25-receipt.v1.meta.json` | `5e9b1747d4c0465b36701e904484298b0ea52a91ef62b9badf963e7b29bbff07` |
| F25 | `documents/f25-supplier-status.v1.json` | `668b681689c4a168d32744864569355dfdec7cf618cdaf93619237c0322c3323` |
| F25 | `documents/f25-supplier-status.v1.meta.json` | `620fd4388cec0d8cfdbd876e5a283accdcd81f8865afb2056f3f9a5ecd06835a` |

Case files, changed only by the two substitutions above:

| Fixture | Old `case.json` SHA-256 | New `case.json` SHA-256 |
| --- | --- | --- |
| F01 | `ab45044fa77b03c9ae7b7f0c80db111352546459ed0c0474bd0ff3b6878a0b6c` | `cbe662b268a86025214996d4c32953af3b52408c6755c06c151a3b2bb8767b2f` |
| F02 | `c5ca67ef97025b8b3b763e4284ff1af5f0ba3ae2b8635329ba369d1e879fcf23` | `f5215cb8db7879394f723955a55970da97c348ffec71bf83f849acd4be02b399` |
| F06 | `d9235895ad6d1c1215996e749c4f30d65626bb5b9f4f79fae7bac255aa2fa212` | `85ba77e8171a8c23be81d7774148a87a92106096b354eae43938a699cf3441aa` |
| F08a | `7ba00fb7896913b25421dd32f3f7a0354ec0f01882c191186447f679aec81e5a` | `4635306cb85536f4c39408306ee143dadf9689a5b1fd6b6a372c018784214f51` |
| F08b | `f1ffa84299152276594636f4dc9bc83bb61e6662ec161b4cfd8c59177171f9cc` | `773858f9b2fa675cec2e040a39333a6b1b667825e0e073dde4a7250447c450b1` |
| F22 | `29a1f904a57da34456ce3fc1d4a97d24ba12bac7810d5a58665fc20b3d5abf75` | `d5fab388c4aee2bdc8531fe21af5f4e92a87a25dd9ff73c046fe718e2dd8ca93` |
| F23 | `457aa003510130ff4bfe5d570a1a34559c1d43bec91201b36923bef51ebd8f18` | `ea551ce8d64dd182d2ba42857d4d11764c9626e8f5dcba386060995ae28ba831` |
| F25 | `480d3e7a9580b872622e658620129e84598901941c8f7d25c1797f0921f0edaa` | `81ab7b57bb1a920c92bea1836dda932120bb3466ac910c21150270eb484826ec` |

### Pins

The table `evals/src/frozen-v2-migrated.ts` pins each manifest and oracle by
SHA-256, computed with `shasum -a 256` from the files at the revision that adds
this section. The frozen values are recorded from the files themselves after review.

| Fixture | `manifest.json` SHA-256 | Oracle SHA-256 |
| --- | --- | --- |
| F01 | `867f4ee978aabef801e5f565c9038118b5ebb71602ae8b9ea0cb51093f676879` | `3cf5f1a59f4b432dc5ad6e17d849336c80bb1584b0ee2deaea4acc4038a521e4` |
| F02 | `e923aac006e87994affb00af0ce5a6aebe5a83b5a7382d23a9f5adb919e30801` | `db1d402c2eb6b2b5601f9931e0b4c1bcf8fad504a4e4516ae6acc33d2731a4ea` |
| F06 | `2b763e59234020dd607cb9ecc4d2ed223b2e62146fa7d7d3f7d58cb805a86f19` | `ee2ed9afa3fe6b3b714cf521e9c99887476086cd9b6773820909c84c42691141` |
| F08a | `1bd2ec9b63c6499a599e49a4b35f3fab5a722433c962bbf87b2834e6c0b9b0d8` | `7766c879e7d4110bce2dbdb24b480ff50e804ad5ac8199040f8b81c566c0497e` |
| F08b | `d794aea65950c4465100d91341ead1cb82644383a08017ba6cc86ab7fa89c480` | `d69bab62c6ee47920b5dafcc0cb2a7840b32bb856abf4910c6fe148ade6c1c59` |
| F22 | `39695ba4743fa9d399dcf3f533f8d82bf2ee3e7edf8ef1f51901cb24a523b9a8` | `e83c8e2f717e87242937211bedf6ffa3a7cc95d214c2a967199929977d205cfa` |
| F23 | `f4646c5de25b6b0ced633b612a10b1f181f56d8049ee8c758ad37f9cda7ef108` | `618a2a8111b35035721e660b80a07fc1a7b7c4dbc8082e246f8cc1b1692a57a7` |
| F25 | `0b078b4aed76ed606fff8d796655375130d524557fac8fcf69fae3047bb8061c` | `18f3c907c3743837df073e1c4eb709a3ac42a02a2e902f73b3102715364869fb` |
| F01x1 | `e909c93a80ae592029a1a260a987543e943fd3aec4f6250f593431d5375adc5d` | `a6750c282d31a8e354c732cdbdc8dd337687d9412d9424be157a26481a71f5de` |
| F01x2 | `7331739383e503e18f931468c978b70420fa7d99c049e43aecc248eeda42d3a2` | `075c5bcec3a3ae27435f80dd84e9913c32d4f50ce7508fff0d74fea6aa58cd39` |
| F01x3 | `a4b626f639f8cd27d458e02f06e32575e78739c293800f8c5de177515f45c0e6` | `9b0b32ab77dc2ff7c458f8efd4061f19ba384c857fb131738e8088ae4fa1c6dc` |
| F25x1 | `f397cf99ef38fc8ce65951e43cfe455e3ab4f54b31d650a25622582d8508c8e1` | `8741e2d97872bf5983dd445d2c2323914219b06186f35ddabcd5e4b3c5f16d3f` |
| F25x2 | `74b3b4243ca038de4f57879a359b80f2435d38877aa7413d719d7b16320a9801` | `2fb882c6c289e8aa85a134a4ad505b64a29ef1b68fce54d1705a4636ed239cff` |
| F08x3 | `f08bbe8085074541a2599e3adce6ec2d23eb6f2b784b250be4d1539b32ab0fb2` | `709dc6b24900db26801fe5ee393c315ed01c61dc2a95a6472d0704b33da5d90f` |
| F14x1 | `b98adbb4e44249e73b1aa502548e9e3fd43c822d271543efe318f74744f3787e` | `a6a236bee4b46f5aa1589a3e21720d5947e572b8edb939ab2b3583ab23cbc840` |
| F14x2 | `488470b2e1c642b9e876be7226c7575d4fd3334fa200b64565d5bacd80fa405b` | `ddd0d5a4bae0c664fb45b111436e970c24f2f5fba10c65f501e6093a47cf5f22` |
| F03x1 | `9dd62a60fae4a56d32a0473ae3d77e5f4aa6406fb15639e231a590d61f241b80` | `5538e02de175a0dabf37117663f30d66d526be2c89827749c91c959f522c20e3` |
| F03x2 | `18a308f69f19d7ce99385cf80aa479d9e1dfc124be16699360b3cf78384fb8e6` | `9e7a4537762d53527e9b8683d72399c50f6b43b7c71425e644ec063573fe674d` |
| F14x3 | `86f0defbc2847c1ca122fa02b965af151a5f0e52248b0da240d44f8832653af3` | `27b47a7b9df2270e6350ad6c2b6fe44b41dadb4d6e4ccca473d197d7b9225119` |
| F26x1 | `d046e182a405296b8296a85b39aef9a191d330812c05e3d9f4a4b1ecb70007c1` | `13fc524bfe42c2c4528ad9f137c9cbd03f790183ab080842d4f98c77a35d9eeb` |
| F26x2 | `b368f2a26b854c6262bb5757378b5c4911315ff4b6f75bb67f4f555d395cf0b6` | `49deb6fa54d49ab5566852997581d63b1f1ceec4bfb75f94528f4a1c0def342a` |

### Authoring helpers and independence

A scratch helper in the system temporary directory, never committed, wrote the
bytes. It serializes the hand-written source values in the field order of the
first-slice originals, copies the original blobs, computes SHA-256 values, formats
citations from a hand-written list of (document, version, locators) per rule
and writes manifests and oracles. It decides no usability, binding,
supersession, chronology, status, condition or state. The helper and its
selection list are disclosed to the independent oracle reviewer. Inputs were also parsed with the public v2 contract schemas only, to
confirm that exactly the intended inputs are invalid: the F01x3 note bodies,
the F25x1 case and the F25x2 case and two sidecars, plus the deliberate F26x1
hash mismatch. The author did not read `fixtures/README.md`, the preserved
prototype, domain code, harness output or domain tests.

### Coverage and gaps

- Part B (D3 both directions, D4 supplier provenance, the D5 supersession
  vectors including every F13 partial-snapshot case, and R09 first-condition
  routing) belongs to the version decision batch. This batch contains no
  supersession edge.
- Ordinary F03, F04, F05, F07, F14 and F16 variants belong to the core-row
  batch; ordinary scope and boundary rows, including the ordinary F26 receipt
  cases, belong to the scope and boundary batches.
- This batch runs no assessment. The version 2 assessment compares results and owns input-array-order
  invariance; arrival order, recovery and human acceptance remain S4.
- Structural validation was exercised on macOS only.

## Core-row oracle batch

This is a data addendum, outside the frozen version 2 specification and the
structural validation and migrated-batch addenda above. Batch `policy-v2-core-rows` is the hash-only
table `CORE_ROWS_BATCH` in `evals/src/frozen-v2-core-rows.ts`, registered third
in `evals/src/v2-batches.ts`. It pins the same reviewed v2 pack as the core
batch and no negative policy input. The catalogue was approved with corrections
after two independent catalogue reviews. Every expected state, status, condition, role,
reference and citation was written by hand from the SPEC, the v2 pack and
conventions C01 to C09. No assessment engine, harness output or domain test was
run or read to obtain them. `pnpm test:oracles:v2` checks this batch only
structurally; it is not a proof of policy completeness.

### Fixtures

The batch holds 24 assessed fixtures and no rejected expectation, in 266
fixture and oracle files. Each fixture is `F<row><letter>`, named after the
SPEC row it exercises, except F16f, which keeps its catalogue ID but exercises
row F02. Every case has its own synthetic subject, the explicit assessment date
2026-10-18 and a supported K0823 scope. Unless a row says otherwise, the packet
is a final encounter on 2026-08-20 and a final signed order on 2026-09-02 by
practitioner identifier SYN-PRAC-0001, a receipt of that order at
2026-09-03T17:05:00Z and the current supplier record.

| Fixture | SPEC row | What it isolates | Expected |
| --- | --- | --- | --- |
| F03a | F03 | Order without signature metadata | `needs_information`; R03 `element_missing` (signature) |
| F04a | F04 | Same practitioner name, different identifiers | `needs_human_review`; R04 `practitioner_identifier_differs` |
| F04b | F04 | Order names the practitioner without an identifier | `needs_human_review`; R03 pass, R04 `practitioner_identifier_absent` |
| F05a | F05 | Order 23 days after the C01 bound | `needs_human_review`; R04 `order_after_bound` |
| F05b | F05 | Order eight days before the encounter | `needs_human_review`; R04 `order_before_encounter` |
| F05c | F05 | Final encounter states no date | `needs_information`; R04 `date_not_stated` (encounter date) |
| F05d | F05 | Final order states no date | `needs_human_review`; R03 `element_missing` (order date), R04 `date_not_stated` (order date), R05 `receipt_unsequenced` |
| F07a | F07 | Order exactly on the bound 2026-09-15 (184 days) | `ready_for_review` |
| F07b | F07 | Order one day after the bound 2026-09-15 | `needs_human_review`; R04 `order_after_bound` |
| F07c | F07 | March 31 clamps to September 30 | `ready_for_review` |
| F07d | F07 | Leap day 2024-02-29 keeps day 29 (bound 2024-08-29) | `ready_for_review` |
| F07e | F07 | August 31 clamps to leap-year February 29 | `ready_for_review` |
| F07f | F07 | August 31 clamps to non-leap February 28 | `ready_for_review` |
| F07g | F07 | Order one day after the non-leap clamped bound | `needs_human_review`; R04 `order_after_bound` |
| F07h | F07 | Same day, only the encounter time stated | `needs_human_review`; R04 `same_day_unsequenced` |
| F07i | F07 | Order one day after the leap-day bound | `needs_human_review`; R04 `order_after_bound` |
| F07j | F07 | Same day, only the order time stated | `needs_human_review`; R04 `same_day_unsequenced`, R05 pass on the timestamp |
| F14a | F14 | Two final orders disagree on the order date only | `needs_human_review`; R03 and R04 `orders_disagree` (order date) |
| F16a | F16 | Encounter access restricted | `needs_information`; R04 `encounter_restricted`, R09 `access_restricted` |
| F16b | F16 | Encounter not supplied | `needs_information`; R04 `no_usable_encounter`, R09 pass |
| F16c | F16 | Encounter reported unreadable (declared access status) | `needs_information`; R04 `encounter_unreadable`, R09 `access_unreadable` |
| F16d | F16 | Usable draft encounter beside a restricted encounter | `needs_information`; R04 `encounter_restricted` and `encounter_not_final`, R09 `access_restricted` |
| F16e | F16 | Encounter fails provenance validation (hash mismatch) | `needs_human_review`; R04 `encounter_failed_provenance`, R09 `hash_mismatch` |
| F16f | F02 | Only a usable draft order, no final order | `needs_information`; R04 `order_not_final`, R03 and R05 pass |

Each oracle's `authoringNote` gives the reason for every expected value. Every
oracle expects R06 `manual_review` for the qualified clinical reviewer with
`R06.clinical_review`, R08 pass, R10 `not_applicable` with
`R10.pure_assessment`, empty quarantine and superseded lists and
`clinicalReviewRequired` true. The five ready fixtures defer human acceptance
to S4; F16a to F16d defer the neutral request for the existing encounter record
to S4, and F16f defers the neutral request for the existing finalized order to
S4.

File totals: the 19 fixtures other than F14a and F16a to F16d hold 11 files
each (case, manifest, oracle and four payload and sidecar pairs), F14a holds
15, F16a 10 (the restricted encounter has a sidecar and no payload), F16b 9 (no
encounter version at all), F16c 11 and F16d 12, for 266 files.

### Distinctions from the migrated batch

- F03a isolates one order without signature metadata; migrated-batch F03x1 places a
  complete order beside it and F03x2 tests signer names that differ.
- F05b isolates `R04.order_before_encounter`; migrated-batch F14x2 holds that key
  among several conditions.
- F07h and F07j each state one time; migrated-batch F06 states neither.
- F14a isolates an order-date disagreement between two final orders; migrated-batch
  F14x1 tests encounter dates, F14x2 several simultaneous conditions and F14x3
  a draft beside a final order (R03 only).
- F16c isolates the declared unreadable access status with a well-formed,
  hash-matching body; invalid bodies (R09 `body_invalid`) are migrated-batch F01x3 and
  unsupported MIME is version-decision F08x4.
- F16e is distinct from version-decision F13x4 (failed-provenance order) and migrated-batch
  F26x1 (failed-provenance receipt beside usable receipts; R09 `hash_mismatch`
  and R05 `order_receipt_missing` for the second order, not a receipt
  candidate).
- F16f has a draft order and no final order; migrated-batch F14x3 has a final order
  beside the draft, so no not-final condition holds there.

### Readings applied

- Recorded reading: a rule cites evidence-field facts only from the documents it reads,
  and R04 reads only final current usable documents. F16d's R04 finding cites
  only the final order's status, date and practitioner identifier, and F16f's
  only the final encounter's, while `R04.encounter_not_final` and
  `R04.order_not_final` name the draft. Rules that read drafts (R02, R06, R07
  in F16d; R01, R03, R05 in F16f) cite the draft's facts.
- C09: when no final current usable encounter exists, R04 reports restricted,
  unreadable or failed-provenance candidates instead of a false absence, and a
  usable draft does not hide them (F16d). The C07 parent of R04 names only the
  documents of held candidate conditions at the finding's status.
- An unavailable or unverified encounter supplies no fact: F16a, F16b, F16c and
  F16e cite nothing from it, R06 keeps its clinical review condition with no
  citation and R07 passes with no citation, asserting nothing about the
  unavailable record.
- F05c and F05d are missing-date vectors (`R04.date_not_stated`), not
  outside-interval conflicts or C01 boundary proofs. Metadata `authoredAt`
  never substitutes for a stated medical date. F05d's R05 result rests on the
  pack's explicit `receipt_unsequenced` predicate for an order with neither a
  date nor a timestamp; there is no C06 span to compute.
- The F07d to F07g and F07i medical dates are older than the assessment date
  only as C01 arithmetic inputs. No rule compares an order's age with the
  assessment date and no order-age limit or clinical validity is implied.

### Pins

SHA-256, computed with `shasum -a 256` from the files at the revision that adds
this section. At that revision `evals/src/frozen-v2-core-rows.ts` was
`e244957b2775b7d5ef74812a55b059433cfbfea828a67c985cbba06390913eb0`; later
comment-only edits change that file hash but no pinned value. The frozen
values are recorded from the files themselves after review.

| Fixture | `manifest.json` SHA-256 | Oracle SHA-256 |
| --- | --- | --- |
| F03a | `09868f90e652a033b0dd6f8f410375dbc609bc3692dd52f1a564eac32e057706` | `d46b665ee99405b72cef2376e081dfbf1426795e5294781b913028bcb7b1bb31` |
| F04a | `892987b0f16d980153a8e4d1ffc5eb9b929a169dd6e6bb2099a99b6701b4a444` | `c86121f86f74a4b2949886cd124398d04f8e372d05c54ff8f6652cb43d2fea72` |
| F04b | `c8a62bf3d585646e9ce6a7d81c20bddd19afb44a73474e7b4b392dfb21752aea` | `1201cb7bdb845df7fc441c3dee31c17dbf00df89407795fce7afeda87baca7d2` |
| F05a | `71b0375db96e81e531e70a9783d059af2e2a967c47c904932faab4de2a641d58` | `42d1a6d801192b7140bc65d5bed5a558302266f6e62279ca20d1ee33f71dcc0a` |
| F05b | `e7bfa5231ad31a10e4b440472f8073e06756952635ed98f3d1c45e5b3dab15e1` | `f6d4551dd161a0088ecad622527ccd34bcdafc74b518af0d8746f5a8dc343167` |
| F05c | `3ffe91ed5179e683320d465c4113fa2ac9a038fcc84a1c6ddb0797e45e0773ab` | `45e8da0ee47eae5f091bbd00611e996c558524f957fe9e3a0200ea43d6458dbe` |
| F05d | `1f9e373b67bd09ce68490e4a81aee9174b1eead0a3108f2badc8d89e143fbe44` | `03af5685247b65cae70f386d4cb2a46dedcb0b540d8d88f3101ebb0230bc215c` |
| F07a | `d9bcbc9f1b604f7764fdd76578dde0471a59a432e13c33a018f52b85141bce82` | `66fe02dddd5ea4e125bdd28cbc476c956557b56724d395df45f8537d3eb42fae` |
| F07b | `ed550621d70aa846d635ee53549857fbd655311ccbfcc77d5eade0424ac37652` | `cc0f85ddf39c910f9df11687d422f9200c26bd54f8ddcda708a533e13ca3a945` |
| F07c | `a99c28f2e619af31c3914c7e490eefe7ab3e2fbc0d82dfa07fc0a89d7868d7e5` | `4fc6f8acc0ba18b17da544bf2cf80649d03ec5875b7ef09d749d02a0a75a5969` |
| F07d | `27821f8af1c1b73da88043bd2194e2b36935e99bd30590cdb78537270f111550` | `c8bb33789a82b44e966fc2596ffff60174b0147a00adbf67910ec51a1d55e15d` |
| F07e | `1450faef40217a1b0b570c9a3f92420b2b840fab10134da18ecd9821e10c0d87` | `636f3ef448c9ded154c2686ff3ef2e582e37a56439410686c41ced86652a4344` |
| F07f | `5abf1d6c623a73e121c8a5058f0a282bf9ca5d549562a4d4f23cf14fac167be6` | `e711586dcc9b7a7555fa656854bfc3342921f3914e606236b92780a535bf7b0a` |
| F07g | `bdb83474c02b82c99b4e687a48ed7d2feedae4563ccbdd29a2f726f4dc14de3d` | `bfd95a9e09f9bfb465b2102cd65260a7d1e4500c8e7d552164e98f5075e022bf` |
| F07h | `3a0799967c8a2403e12e3030fb1e7b68bd8838441932c0a30e9932d69bda74e9` | `4be65f45267183dcf110c57c0343fe94a5e54baee58a13b7648cb0fc9ec4191c` |
| F07i | `d25ac863d83cb113a2d9a54613674b063f87c3097917374c04d6e6c99da513d2` | `fb7406a927c3a4463d1cff7b36b7390def4878a6a8778e5ae4fa3db4ba01214a` |
| F07j | `a7333b27ae55d13d17420b209d14eac5bbf99d8e2a9d54d28cfefa85c8224124` | `2e2265c126e8a12ebecd9d263c596f8c939ade0705e948f0dee4098922e408b9` |
| F14a | `ab0adf6c64aa23029e74fc5ec63c910ab32e438b414679ebb9eae7c2465cc4ce` | `79a3f507f19d3454c94e3e2fe8e577f5e68cc12e32011ab0a8be7e2bfc38922a` |
| F16a | `44d2e8010b34abd4d744d725765f172cb9edca45925ce820c4fbd7b5e4775479` | `2499a95bc6bc1a6509ea93ff8bc36db9a70bfd5da18202c8ee8c7f6c071c872d` |
| F16b | `05ac193aec0040a3383e3e2a2733b5694e27a6ca1058fd2c6389ae9b609e03cf` | `670afa247bbcbeb069f9db22e8d29b719e95255988b7b885079b87d51258d122` |
| F16c | `528e79349d5a74bca99b1e130fe33bb3bf531979a77eb2fb42fd432ea581f2aa` | `61f09ddcf808bab1c27883594ec9eaaee58b2372f20c5ec8b28ecd803172375a` |
| F16d | `6db287d0e469829cdd98b92e324019e6267cb09684f98c4ff89024b456d6d244` | `4d4c27bba9e6ff2d036d53961d8bd8e7449553f9814814c3e2228f9436e2dd31` |
| F16e | `b2412b345fdc3428bbe81bb4c8e9a38ea98ff64fed5e846c26ddff0c8b9a3457` | `a4a022d443791406a5c0f5215b1b857bd5c3de1da985016a5a54c307ddac0fb2` |
| F16f | `aabf24505c0027b31370f490691ffc6ae31ba30d41fad5c1b54ccc506d695f4f` | `4e1830bf4c1c8fd25ea9a964c9b508ff19fda8f9e3c66d8372f29a79add9fb03` |

### Authoring helpers and independence

A scratch helper in the system temporary directory, never committed, wrote the
bytes. It serializes hand-written source values in the field order of the
migrated fixtures, computes SHA-256 values (including the F16e alternate-bytes
content hash), formats citations from a hand-written list of (document,
locators) per rule and writes manifests and oracles. It decides no usability,
binding, chronology, status, condition, parent set or state; it only asserts
the canonical order of the hand-written condition references. The helper and
its selection list are disclosed to the independent oracle reviewer. Migrated fixtures and oracles were read for format only. The author
did not read domain code, the assessment harness,
harness output or domain tests.

### Coverage and gaps

- R09 `kind_mismatch` and `locator_unresolved` are outside this batch and the
  migrated batch.
- Part B decision vectors (D3, D4, D5 supersession and the remaining R09
  routing) belong to the version decision batch; ordinary scope and boundary
  rows belong to the scope and boundary batches.
- This batch runs no assessment. The version 2 assessment compares results; arrival order, recovery,
  requests and human acceptance remain S4.
- Structural validation was exercised on macOS only.

## Version decision oracles

This is a data addendum, outside the frozen version 2 specification and the
earlier addenda above. Batch
`policy-v2-version-decisions` is the hash-only table `VERSION_DECISIONS_BATCH`
in `evals/src/frozen-v2-versions.ts`, registered fourth in
`evals/src/v2-batches.ts`. It pins the same reviewed v2 pack as the core batch
and no negative policy input. It is Part B of the approved catalogue split. Its
catalogue was approved with the corrections of an independent catalogue
review. Every
expected state, status, condition, role, reference and citation was written by
hand from the SPEC, the v2 pack and conventions C01 to C09. No assessment
engine, harness output or domain test was run or read to obtain them.
`pnpm test:oracles:v2` checks this batch only structurally; it is not a proof
of policy completeness.

### Fixtures

The batch holds 16 fixtures, 11 assessed and 5 rejected, in 206 fixture and
oracle files. Every case has its own synthetic subject, the explicit
assessment date 2026-10-18 and a supported K0823 scope. Unless a row says
otherwise, the packet is a final encounter on 2026-08-24 and a final signed
order on 2026-09-08 by practitioner identifier SYN-PRAC-0001, a receipt at
2026-09-09T16:30:00Z linked to the stated order version and the named supplier
record (2026-02-01 to 2027-01-31). O1 and O2 are versions 1 and 2 of the
packet's order; S1 and S2 likewise of its supplier record.

| Fixture | SPEC row | What it isolates | Expected |
| --- | --- | --- | --- |
| F08x1 | F08 | Body-quarantined O1 superseded by usable O2 (snapshot only) | `needs_human_review`; R02 `document_quarantined` (stated identifier and name) for O1; O1 superseded and quarantined |
| F08x2 | F08 | Usable O1 superseded by body-quarantined O2 (snapshot only, approved D3/D5 reuse) | `needs_human_review`; R02 `document_quarantined` for O2; R03, R04 and R05 `no_usable_order` |
| F10x1 | F10 | Named supplier record fails provenance, no replacement (snapshot only) | `scope_hold`; R01 `supplier_record_failed_provenance`, R09 `hash_mismatch` |
| F10x2 | F10 | F10x1 plus usable same-ID S2 with `supersedes: null` (snapshot only) | `needs_human_review`; R01 pass on S2, R09 `hash_mismatch` for S1 |
| F13x1 | F13 | O2 corrects O1's item code K0822 to K0823 (partial S3 snapshot) | `ready_for_review`; O1 superseded, no stale code |
| F13x2 | F13 | Restricted superseder (partial S3 snapshot) | `needs_information`; R03 and R04 `order_restricted`, R05 `no_usable_order`, R09 `access_restricted` |
| F13x3 | F13 | Declared unreadable superseder with hash-matching body (partial S3 snapshot) | `needs_information`; R03 and R04 `order_unreadable`, R05 `no_usable_order`, R09 `access_unreadable` |
| F13x4 | F13 | Failed-provenance superseder (partial S3 snapshot) | `needs_human_review`; R03 and R04 `order_failed_provenance`, R05 `no_usable_order`, R09 `hash_mismatch` |
| F13x5 | F13 | Restricted O1 superseded by usable O2 (partial S3 snapshot) | `needs_information`; R09 `access_restricted` for O1, R01 to R05 pass on O2 |
| F13x6 | F13 | O2 supersedes an absent O1 (partial S3 snapshot) | `ready_for_review`; no applied edge, empty lists |
| F13x7 | F13 | Same-ID supersession across kinds (partial S3 snapshot) | Rejected, `snapshot_integrity`, `supersession_cross_kind` |
| F13x8 | F13 | Supersession across metadata subjects (partial S3 snapshot) | Rejected, `snapshot_integrity`, `supersession_cross_subject` |
| F13x9 | F13 | Supersession across document IDs (partial S3 snapshot) | Rejected, `snapshot_integrity`, `supersession_cross_document` |
| F13x10 | F13 | O1 supersedes itself (partial S3 snapshot) | Rejected, `schema`, `document_metadata_invalid` for O1 |
| F13x11 | F13 | Cycle-shaped input: O1 forward to O2, O2 back to O1 (partial S3 snapshot) | Rejected, `schema`, `document_metadata_invalid` for O1 only |
| F08x4 | F08 | Notes q, h, m and u: metadata quarantine and first R09 condition per version | `needs_human_review`; R02 `document_quarantined` (metadata subject) for q; R09 `access_unreadable` (u), `hash_mismatch` (h), `mime_unsupported` (m) |

Each oracle's `authoringNote` gives the reason for every expected value. Every
assessed oracle expects R06 `manual_review` for the qualified clinical reviewer
with `R06.clinical_review`, R08 pass, R10 `not_applicable` with
`R10.pure_assessment` and `clinicalReviewRequired` true. Manifest coverage
lists only SPEC rows, decision IDs and declared condition keys; the universal
R06 and R10 keys are omitted from coverage and kept in every finding. The five
rejected fixtures each have coverage `F13`, `D5`, `D6`; their stage, code,
reference and pointer are in the expectation and rationale only.

File totals: F08x1, F08x2, F10x2, F13x1, F13x3, F13x4, F13x7, F13x8, F13x9 and
F13x11 hold 13 files each (case, manifest, oracle and five payload and sidecar
pairs); F13x2 and F13x5 hold 12 (the restricted version has a sidecar and no
payload); F10x1, F13x6 and F13x10 hold 11; F08x4 holds 19, for 206 files.

### Readings applied

- Recorded reading: a rule cites evidence-field facts only from the documents it reads,
  and R04 reads only final current usable records. Every usable encounter and
  order in this batch is final, so the reading excludes no draft here.
- C08 and C09: a superseded version is never current and never a candidate.
  A restricted, unreadable, failed-provenance or body-quarantined superseder
  keeps its trusted edge. When the only current order is unavailable, R03 and
  R04 report its candidate condition and R05 reports `no_usable_order`; when it
  is quarantined, R03 to R05 report `no_usable_order`. The usable unlinked
  receipt is still cited by R05.
- An unavailable current order (F08x2, F13x2 to F13x4) leaves the citation
  vector R01 to R07 `7,4,0,3,3,5,1`: no O1 or O2 locator appears anywhere.
- C07: R09 names the union of its condition documents (F08x4 names h, m and u
  although only h sets the conflict status). R01, R03 and R04 name the
  documents of held restricted, unreadable or failed-provenance conditions at
  the finding status. R05's `no_usable_order` names nothing.
- R09 reports only the first applicable condition per version, in the pack
  order. Metadata-quarantined versions are reported by R02 alone (F08x4 q).
- No supersession is inferred from a larger version number (F10x2) or from a
  document body (F13x8).
- Deliberate provenance failures hash separately specified alternate bytes:
  F10x1 and F10x2 S1 (`effectiveTo` 2026-06-29), F13x4 O2 (`orderDate`
  2026-09-10) and F08x4 q and h. The held bytes of F10x1, F10x2 and F13x4 carry
  values that would change the expected set if an unverified or unreadable
  body were read. Manifest pins always hash the actual held bytes and
  sidecars.

### Partial snapshots and deferrals

- F08x1, F08x2, F10x1 and F10x2 are snapshot only. F10x2 holds two current
  supplier versions and no supersession edge; its limitation is snapshot
  replacement and reassessment, not an applied relation.
- Every F13 oracle is a partial S3 snapshot. Version selection in one snapshot
  does not prove arrival-order recovery, history display, replay or rollback
  prevention; those remain S4 and are recorded in `deferredExpectations` for
  the assessed fixtures. The rejected fixtures state the same limitation in
  their `authoringNote` and keep the strict rejected expectation shape.
- F13x5 records the conservative limitation that a restricted superseded
  version still blocks through R09. It is not completed F13 recovery.
- F13x6 repeats its supplied-endpoint checks when the absent version arrives
  in S4. F13x1 and F13x6 also defer human acceptance; F08x2 and F13x2 to F13x4
  defer the neutral request for the existing finalized order.
- F13x11 is the approved cycle-shaped input for the forward-reference proof.
  `supersession_cycle` stays structurally defined and unreachable after valid
  metadata.

### Distinctions from earlier batches

- F08x2 differs from migrated-batch F08b by a usable older version and a usable
  receipt, so R05 reports `no_usable_order`, not `no_usable_receipt`.
- F13x2, F13x3 and F13x4 concern a superseding order, with R03, R04 and R05
  effects; core-row F16a, F16c and F16e concern an encounter without
  supersession.
- F08x4's m and u add `mime_unsupported` and `access_unreadable` on notes;
  migrated-batch F01x3 covers `body_invalid`.

### Pins

SHA-256, computed with `shasum -a 256` from the files at the revision that adds
this section. At that revision `evals/src/frozen-v2-versions.ts` was
`5dcfb69160630c76a5049af5c9ad010600cecd5e83362eeabc4ae930f32aa61f`; later
comment-only edits change that file hash but no pinned value. The frozen
values are recorded from the files themselves after review.

| Fixture | `manifest.json` SHA-256 | Oracle SHA-256 |
| --- | --- | --- |
| F08x1 | `7f212038844bd0a0f9975c28b1773d400f93d6809bf4791bed9d7b589acd8eb1` | `15f10e198218ce67deed505f8c51cbeaec59bfe15eafef892d55427ab1469210` |
| F08x2 | `5ef49b45cb1f471c6d0e5aaf90a7eddf78b2e6747bd51b6119f7f911c4e90b78` | `2edcb862ae97ee911a0d385a3796247fd08a4d5e8ee35b279b2ccdfce5619265` |
| F08x4 | `134160097035b35f33faea66f98b715bebee97aa7a7144e37092117b05dd24a0` | `2438637ed5353b765da86433486dcfa07d15e85ab950b0fab256bfd706784535` |
| F10x1 | `1367024b8645f0bbcb2c5b34dcb9825282699e4c8a8a4060eb579e05fdd1e736` | `25e94bb163aab4d5bb07c08ad0ac1c0791f615b1da3ff622e65a63336347c89b` |
| F10x2 | `3d9ec86924d4d38560bfc0aa7f795221d8936a1ab6cdcf8a6688b3c151bae14e` | `d8aabe3a2f4546ac71aa89c9e6565d9de003fc91665a9c5f46866fb64fe34eb1` |
| F13x1 | `70ef009c071f2eff9191a3bf2563ceb99ecee5480a4129fe4daff7d42f2f918f` | `18bfe4fcff75b6a91a6532ba21cc41aaf0da0bdd3af05747c4602652f49d5e44` |
| F13x2 | `827a7c17fb5dba09d14c1976e604ed4495e96482399d5b43ddac7ba119c9521a` | `fdada145d20aa12477e4c5ee208428c9d8345ce3b5b14ae6ab7d4c0ccd7f2faf` |
| F13x3 | `d6430d2671bb79d194289565654c75a944ae0dd946dc8cf8b079f381ab2f0530` | `6c997e685e0bbe2f4dd49c800506fd8b18b6e51375be8c0a5cda239e194c81c6` |
| F13x4 | `9051612b71ffd7dc5ae77539693a0c8c61a1add0cc36033703ccea83bbac19db` | `dab953be187330117742d9c3dfcd6434ebbd5ebd5cfa53eb6f74b113b4992ca2` |
| F13x5 | `8a66ed67b764e6cf0ed024e0fd8b3f7296880e84bad0dba13555d13a8021e54c` | `df576ae87e883a214582cd88a977fb3acbf16f0840cc3fd7e935a68dce7f2c2e` |
| F13x6 | `f1007fcee643451bc8d8b1d7248d0d6976693d6d9fe1c65ca8b55fe364e65180` | `957e960ab3bde7fc71a481efcc8c98ddacc70aa99b115ce055e86fc7de7a8878` |
| F13x7 | `eede0ab8fb2d8bcc567f497d8ef4e2b70070972aa40606f78d4889e5c25353d5` | `2fd3aab484ad1b048188a2ae98b3a1ad00e1991e7383f88a636ff5d4c5a4009c` |
| F13x8 | `30d4be6d09f94034b680ec3d4f081a83fd36749a3a4c63f934b722e7391ac741` | `cc9292345e390ea83f963b671ff0b7364cb57c59d4fe37123c3d1cdefc156b31` |
| F13x9 | `1b8288c73796de456dea2af973a29b782f76abac426ab12a86cc015915dda2b6` | `3416a9eb1fc3301126215584a2e53d9a13d2bbf1fbe6b5e06501997c462b35b6` |
| F13x10 | `fec2f5797b6127a989cd7ad43135fca67b5a024bb4bf9cac8926d0527b3c4d62` | `c2a301b60642b84d82523007eae9715bc387e59d5a2158515a9d92000bf92a12` |
| F13x11 | `fb7327c1cdf5b0eb26b361cef73ff7d2ccca056b6c7cd037aca2a755502b7a06` | `1cfd1fee1902ff0e1dba76506eb2157cf77b8996e990813788cfa0027f81b3c2` |

### Authoring helpers and independence

A scratch helper in the system temporary directory, never committed, wrote the
bytes. It serializes a hand-written selection list of source values, computes
SHA-256 values (including the five alternate-bytes content hashes, whose
alternate bytes are listed in the selection before serialization), formats
citations from hand-written (document, version, locators) entries and writes
manifests and oracles. It decides no usability, binding, supersession,
chronology, status, condition, parent set or state; it only asserts the
canonical order of hand-written references. A second scratch check parsed
every input with the public v2 contract schemas only, confirming that exactly
the F13x10 and F13x11 O1 sidecars fail metadata parsing and exactly the F08x4 m
and u payloads are not JSON. The helper, selection list and check are
disclosed to the independent oracle reviewer. Migrated and
core-row fixtures and oracles were read for format only. The author did not
read domain code, the assessment harness, harness
output or domain tests.

### Coverage and gaps

- R09 `kind_mismatch` and `locator_unresolved` are outside every batch
  registered at this point. F08x4's h fails `hash_mismatch` first by design;
  the `kind_mismatch` decision is recorded for the scope batch.
- Ordinary F09, F10, F11, F15, F26 and F28 rows belong to the scope batch.
- This batch runs no assessment. The version 2 assessment compares results and owns input-array-order
  invariance; arrival order, recovery, history display, rollback prevention,
  requests and human acceptance remain S4.
- Structural validation was exercised on macOS only.

## Scope and boundary oracle batch

This is a data addendum, outside the frozen version 2 specification and the
earlier addenda above. Batch `policy-v2-scope` is the hash-only
table `SCOPE_BATCH` in `evals/src/frozen-v2-scope.ts`, registered fifth in
`evals/src/v2-batches.ts`. It pins the same reviewed v2 pack as the core batch
and reuses the frozen F15 negative policy input pin. The catalogue was
approved as is by an independent catalogue review, and the matrix decision
split it: this batch holds the scope rows, and the ordinary F26 receipt cases
and loader-boundary vectors belong to the boundary batch. Every expected state, status, condition, role, reference
and citation was written by hand from the SPEC, the v2 pack and conventions C01
to C09. No assessment engine, harness output or domain test was run or read to
obtain them. `pnpm test:oracles:v2` checks this batch only structurally; it is
not a proof of policy completeness.

### Fixtures

The batch holds 20 assessed fixtures and no rejected expectation, in 222
fixture and oracle files. Every case has its own synthetic subject and a
packet of a final encounter on 2026-08-26 and a final signed order on
2026-09-04 by practitioner identifier SYN-PRAC-0001, a receipt linked to that
order version at 2026-09-05T18:40:00Z (after the C06 span 2026-09-03T10:00:00Z
to 2026-09-05T12:00:00Z) and the named supplier record (non-exempt,
established, 2026-01-01 to 2026-12-31). Unless a row says otherwise the
assessment date is 2026-10-18 and the scope is the supported K0823 scope. In
F10 the case supplier status and the named record state the same values.

| Fixture | SPEC row | What it isolates | Expected |
| --- | --- | --- | --- |
| F09a | F09 | payerType `medicare_advantage` | `scope_hold`; R01 `scope_fact_unsupported` (`case.payerType`) |
| F09b | F09 | payerPrimary `false` | `scope_hold`; R01 `scope_fact_unsupported` (`case.payerPrimary`) |
| F09c | F09 | beneficiaryState `NV`, jurisdiction unchanged | `scope_hold`; R01 `scope_fact_unsupported` (`case.beneficiaryState`) |
| F09d | F09 | jurisdiction `cgs_jc` for a CA beneficiary | `scope_hold`; R01 `scope_fact_unsupported` (`case.jurisdiction`) |
| F10a | F10 | status `unknown` on case and record | `scope_hold`; R01 `scope_fact_unknown` and `supplier_record_value_unknown` (missing) |
| F10b | F10 | status `exempt` | `scope_hold`; R01 `scope_fact_unsupported` (`case.supplierStatus.status`) |
| F10c | F10 | newEnrollment `true`, established `true` | `scope_hold`; R01 `scope_fact_unsupported` (`case.supplierStatus.newEnrollment`) |
| F10d | F10 | ownershipChange `true` | `scope_hold`; R01 `scope_fact_unsupported` (`case.supplierStatus.ownershipChange`) |
| F10e | F10 | interval 2025-10-01 to 2026-09-30 (expired) | `scope_hold`; R01 `case_supplier_interval_excludes_date` and `supplier_record_interval_excludes_date` |
| F10f | F10 | interval 2026-11-01 to 2027-10-31 (not yet effective) | `scope_hold`; the same two interval conditions |
| F11a | F11 | requestKind `replacement` | `scope_hold`; R01 `scope_fact_unsupported` (`case.requestKind`) |
| F11b | F11 | accessories `["Z0001"]`, a code-shaped synthetic token | `scope_hold`; R01 `scope_fact_unsupported` (`case.accessories`) |
| F11c | F11 | urgency `expedited` | `scope_hold`; R01 `scope_fact_unsupported` (`case.urgency`) |
| F11d | F11 | requestKind `appeal` | `scope_hold`; R01 `scope_fact_unsupported` (`case.requestKind`) |
| F11e | F11 | alreadyDelivered `true` | `scope_hold`; R01 `scope_fact_unsupported` (`case.alreadyDelivered`) |
| F11f | F11 | item code K0822 on case and order | `scope_hold`; R01 `scope_fact_unsupported` (`case.itemCode`), no order code disagreement |
| F15a | F15 | frozen unreviewed negative input, case names its pack ID | `scope_hold`; R08 `pack_unreviewed` (missing) |
| F15b | F15 | case date and argument 2026-10-19 with the reviewed pack | `scope_hold`; R08 `assessment_date_unsupported` (conflict) |
| F16g | F16 | only encounter metadata holds a valid supporting-note body | `needs_human_review`; R09 `kind_mismatch`, R04 `encounter_failed_provenance` |
| F28a | F28 | irrelevant sensitive-looking supporting note for the same subject | `ready_for_review`; R02 cites the note's beneficiary facts |

Each oracle's `authoringNote` gives the reason for every expected value. Every
oracle expects R06 `manual_review` for the qualified clinical reviewer with
`R06.clinical_review`, R10 `not_applicable` with `R10.pure_assessment`, empty
quarantine and superseded lists and `clinicalReviewRequired` true. Except in
F16g, every finding not named above passes, and the citation counts for R01 to
R07 are 8, 6, 9, 6, 4, 5 and 1 (F28a: R02 cites 8). F16g's counts are 8, 4, 9,
3, 4, 0 and 0. Manifest coverage lists only SPEC rows and declared condition
keys; the universal R06 and R10 keys are omitted from coverage and kept in
every finding.

File totals: 19 fixtures hold 11 files each (case, manifest, oracle and four
payload and sidecar pairs) and F28a holds 13, for 222 files.

### Readings applied

- Every pack rule applies to every case and only R10 has a `not_applicable`
  outcome, so an out-of-scope fact is reported by R01 alone and R02 to R10 are
  still evaluated (matrix decision, question 3). No code is inferred or recommended.
- C07 and approved reading 2: the R01 parent names no document for missing or
  conflict conditions, so F10a, F10e and F10f name the supplier record only at
  condition level. F16g's R04 and R09 parents name the encounter.
- A supplier disagreement needs known values on both sides, so F10a holds no
  `supplier_record_disagrees`; unknown never implies an exempt supplier.
- F15a uses only the frozen negative input
  (`lab-k0823-jd-20261018-v2-unreviewed`, `reviewedAsOf` null) with a matching
  case pack ID, so `pack_id_differs` does not hold. F15b adds no supported date
  to the pack and its supplier interval contains 2026-10-19.
- F16g: the held bytes match `contentHash` and parse as an exact
  supporting-note body, so the first R09 condition is `kind_mismatch`, not
  `body_invalid`. The version is excluded, not quarantined: R02 binds it by
  metadata only. It is the only encounter candidate, so R04 reports
  `encounter_failed_provenance` and no absence (C09). Under the recorded reading, R04 cites
  only the final order. No fact or citation comes from the version, and R06
  makes no negative clinical assertion.
- F28a: note beneficiary facts are R02 evidence fields (C05); title and text
  map to no field, so the note adds no clinical fact, eligibility inference or
  readiness change. Identity citations grant no export relevance.

### Deferrals

- F15a and F15b defer to S4 the invalidation of an existing human acceptance.
- F16g defers `R09.locator_unresolved` to S6 model extraction; the frozen
  input has no proposed-locator field.
- F28a defers to S4 the export exclusion of the irrelevant note, with packet
  and export exposure in S5, and human acceptance.
- `R08.pack_unsourced` is unreachable for this pack and `R08.pack_id_differs`
  is not targeted.

### Distinctions from earlier batches

- F10a to F10f are hash-valid ordinary status and interval cases; version-decision
  F10x1 and F10x2 own failed named-supplier provenance without and with a
  usable replacement.
- F16g's encounter passes the hash, MIME and body checks and fails on kind;
  core-row F16e and version-decision F08x4 `h` fail on hash first, migrated-batch F01x3 on body
  validity and core-row F16f is the draft-order-only F02 case.
- F28a is an irrelevant attachment; migrated-batch F22 is the broad checklist
  worksheet (R07).

### Pins

SHA-256, computed with `shasum -a 256` from the files at the revision that adds
this section. At that revision `evals/src/frozen-v2-scope.ts` was
`f073d319cfbf8c4f759c53ccc0e1041a9df3cbc65dc8b7c7b63ec7547b510f3a`; later
comment-only edits change that file hash but no pinned value. The frozen
values are recorded from the files themselves after review.

| Fixture | `manifest.json` SHA-256 | Oracle SHA-256 |
| --- | --- | --- |
| F09a | `fdc4f0dcaf5b6d875f11fb5b05322f05ba73599115a18c13e0beb3d689b1d32c` | `253d4a442c96d3466851a032a038fe5b2d52afaf89322e0db6486255323477d0` |
| F09b | `af2d4555f1d6f838ebc77308b869a2b846cdaf593606acd2ddc7e8624f4f2c06` | `21a6043299301d9435e9384b69aa96f97e525f73ffa710e722e06ad4bc23d597` |
| F09c | `01c94278104cf89e9b8680d13b82d68dd43b65957a6e965262575f0afc8b37c1` | `986ba28e34b4d3903ff1453b7c21f176f076219a2f728ef93ba737ca46133d8e` |
| F09d | `c0d11a45a72a258982b6b894faadf9e9ca28a18628004aebb0b7bd035af59deb` | `bb848565fa1919af60389c7e5b9abc93532dc639077dda7c515b7b167445148a` |
| F10a | `907aa634edc40255088ff320872aced1d7316345b84f5db95b7610e1ffa88b49` | `b9fcd2307efe1a843b33f07393d0298d7d74918586e77cd33017da78ad1c9420` |
| F10b | `aed6baac53ee177173913c996830bfe535b9411c6a6eaf3a36fd5f98812abe76` | `d470634e0fefb2c9d4598899d9706a502210c9d493adf642cc61385b5e707e22` |
| F10c | `3965b51b18f27ca4907e62aaf1cb1d02ac203e638ffb2a7b7ef5e9d7936f1799` | `7b20a57f2d5550958a6abdbcf57381387c97e66e51931d270592ac5f1ad71034` |
| F10d | `94d9e5e9db348858e66da10993286bea91bfd0a53a81582d1344f10c70b3deff` | `453efae5520937f2447e4dbddce604660eca7247810c0363f20f3bee89361d0b` |
| F10e | `36c910f2e1a5aae1cd58b622f10ceb5b82677ee2fb88ee21b7b40d31e44f3b13` | `a46bcf278fbcbfa92e0a52de7b8195e5579e3ff36923665f90abbebb574b78d2` |
| F10f | `ffd88ebc05e5abf6093a78df9d7496ec39fc57ff119c6333da645e9425b75ebc` | `229014c8df85291c8ea8b929a5ea3ebabe05be44c414801ae17b3d612fc2513e` |
| F11a | `02dbc3f869c1c17da3906095f939793330ade9f2cd8d87cf9922e92f4f8413f1` | `dad201005f6d3ddf2a588d4659d239b58e51457aa651f56c995c7fc096caf8d5` |
| F11b | `4087a9ec32ff8d27ad4e22e4f270b4e7a57190a540f7f5b82be5147ce057c16a` | `682beafc8cfc3011ed8988bc94676f7662d5670d9d3ce0b7c9efd485925f7e9f` |
| F11c | `28408ecfdd60c9eb1ec34b8b5d43f29fd08fc0530f02c4e7d2e59889978be096` | `746ed388492d5697fe780566229345dd55205a7ab56af7a85d2340db4ca0e448` |
| F11d | `952fc9b32a219a7145cb69dbaa3f6f95ccde8c9423e0e95f8895884a4fb8035f` | `7d3cb34ad246268097b49bd7724a76115e9afb79908297ece5d009d6f3acc079` |
| F11e | `e2a65ba39e9f206b5cf3f9c167670d374258d572c2d172a1f42599b5650f6e75` | `6245296df22c0f682aa7e0dff1f2c5e162d5d3141e841033c7ae0bbee121f063` |
| F11f | `f1a7285fd24ea3d726676c791291187214f5b39f9a07e7c7c8d4be297ff1c45f` | `c921bb14239e441de91a92376289d634c2ee3bfde5779566b3a316a1de4043b3` |
| F15a | `8267deea47762dd390f7bca6a0c87e6c066a40d8293bdbaabf3f19558f39e18b` | `31bb7dd7044d57459adc407de9aff175500e76a3863801a1e3690a635acb41fd` |
| F15b | `79acc96fab6c0ed740f18664c02a8a46c0d5f6a4a3d292c6738c337ae531442d` | `b40463a193d206ceaa3fb85fd7dd3bdb06e50907b27a4428c83e359f27fb4aab` |
| F16g | `74c3654b73ffe0c9c3639fe47daf9a42d15d1ec52ade38d88d74715725597ea2` | `60ff65f9cdbac7c827b21851da2a73e991176f3160f2653b32172f54f83f16e4` |
| F28a | `4749c70d08f3a81547809ecd45f35e6e79318cf84208c575335fc61b3cc9a6eb` | `ac4624231f850290a8e8228819f15f9e9587c26c3103d19803f6300066e0335b` |

### Authoring helpers and independence

A scratch helper in the system temporary directory, never committed, wrote the
bytes. It serializes a hand-written selection list of source values and of
per-rule statuses, roles, conditions, parent sets, citation lists, states,
rationales and deferrals, computes SHA-256 values and formats citations and
manifests. It decides no usability, binding, chronology, status, condition,
parent set or state; it only asserts the canonical order of the hand-written
references. A second scratch check parsed every input with the public v2
contract schemas only, confirming that exactly the F16g encounter payload fails
its metadata kind's parser while parsing as a supporting-note body. The helper,
selection list and check are disclosed to the independent oracle reviewer.
Earlier batches' fixtures and oracles were read for format only.
The author did not read domain code, the assessment
harness, harness output or domain tests.

### Coverage and gaps

- The registered union is 81 fixtures (74 assessed, 7 rejected) across five
  batches.
- The ordinary F26 receipt cases and the count, byte, path and combined-invalid
  loader vectors are in the boundary batch. The symlink proof stays with the
  structural validation temporary-tree tests, and the version 2 assessment
  evaluation loads fixtures through the same loader; ingestion
  enforcement remains S4.
- `R09.locator_unresolved` remains uncovered by every registered batch (S6).
- This batch runs no assessment. The version 2 assessment compares results; persisted acceptance
  invalidation, export exclusion, requests and human acceptance remain S4.
- Structural validation was exercised on macOS only.

## Receipt and loader boundary oracles

This is a data addendum, outside the frozen version 2 specification and the
earlier addenda above. Batch `policy-v2-boundaries` is
the hash-only table `BOUNDARY_BATCH` in `evals/src/frozen-v2-boundaries.ts`,
registered sixth in `evals/src/v2-batches.ts`. It pins the same reviewed v2
pack as the core batch and no negative policy input. It holds the receipt and
loader-boundary part of the scope matrix, split by the matrix decision after
an independent catalogue review approved the catalogue as is. Every expected state, status, condition, role,
reference, citation and rejection reason was written by hand from the SPEC,
the v2 pack, conventions C01 to C09 and decision D6. No assessment engine,
harness output or domain test was run or read to obtain them.
`pnpm test:oracles:v2` checks this batch only structurally, plus the actual
loader rejections and recipe pins; it is not a proof of policy completeness.

### Fixtures

The batch holds 14 fixtures, 8 assessed and 6 rejected, in 183 fixture and
oracle files. Every case has its own synthetic subject, the explicit
assessment date 2026-10-18 and the supported K0823 scope. Unless a row says
otherwise, the packet is a final encounter on 2026-08-26 and a final signed
date-only order on 2026-09-04 by practitioner identifier SYN-PRAC-0001, a
receipt linked to that order version at 2026-09-05T18:40:00Z and the named
supplier record (non-exempt, established, 2026-01-01 to 2026-12-31). For the
date-only order the C06 span is 2026-09-03T10:00:00Z to 2026-09-05T12:00:00Z,
both ends included. F26b and F26c add the order time 2026-09-04T09:30:00-07:00
(America/Los_Angeles), which is 2026-09-04T16:30:00Z; no zone is inferred.

| Fixture | What it isolates | Expected |
| --- | --- | --- |
| F26a | No receipt record supplied | `needs_information`; R05 missing with only `no_usable_receipt` |
| F26b | Receipt at 2026-09-04T16:29:59Z, one second before the stated order time | `needs_human_review`; R05 conflict, `receipt_before_order` |
| F26c | Receipt at 2026-09-04T16:30:00Z, the stated order instant | `needs_human_review`; R05 manual review, `receipt_unsequenced` |
| F26d | Receipt at 2026-09-04T20:15:00Z, inside the date-only span | `needs_human_review`; R05 manual review, `receipt_unsequenced` |
| F26e | Receipt at 2026-09-03T10:00:00Z, the inclusive span start | `needs_human_review`; R05 manual review, `receipt_unsequenced` |
| F26f | Receipt at 2026-09-05T12:00:00Z, the inclusive span end | `needs_human_review`; R05 manual review, `receipt_unsequenced` |
| F26g | Exactly 50 counted slots: packet (4), lineage v1 and v2 (2), restricted note (1), declared unreadable note (1), 42 replicated fillers | `needs_information`; R09 restricted with `access_restricted` and `access_unreadable`; lineage v1 superseded |
| F26h | The F26g mix with 43 fillers, 51 slots | Rejected, `input_boundary`: `document_count_exceeded` |
| F26i | One generated note payload of exactly 1,048,576 bytes | `ready_for_review`; R02 cites the note's beneficiary pair |
| F26j | One generated note payload of 1,048,577 bytes | Rejected, `input_boundary`: `document_size_exceeded` for `/documents/f26j-large.v1/payload` |
| F26k | Relative path attempt `../outside-root.json` | Rejected, `input_boundary`: `path_outside_root` |
| F26l | Absolute path attempt `/outside-root/blocked.json` | Rejected, `input_boundary`: `path_outside_root` |
| F26m | 51 slots: packet (4), one 1,048,577-byte payload, 45 fillers and one path attempt | Rejected, `input_boundary`: `document_count_exceeded` only |
| F26n | Nine slots: packet (4), payloads of 1,048,577, 1,048,577 and 1,048,576 bytes and two path attempts | Rejected, `input_boundary`: two `document_size_exceeded` (`-a`, then `-b`), then one `path_outside_root` |

Each oracle's `authoringNote` gives the reason for every expected value. Every
assessed oracle expects R06 `manual_review` for the qualified clinical reviewer
with `R06.clinical_review`, R08 pass, R10 `not_applicable` with
`R10.pure_assessment`, empty quarantine and `clinicalReviewRequired` true;
the superseded list is empty except in F26g. Citation counts for R01 to R07:

| Fixtures | R01 to R07 | Total |
| --- | --- | --- |
| F26a | 8, 4, 9, 6, 1, 5, 1 | 34 |
| F26b, F26c | 8, 6, 9, 7, 5, 5, 1 | 41 |
| F26d, F26e, F26f | 8, 6, 9, 6, 4, 5, 1 | 39 |
| F26g | 8, 92, 9, 6, 4, 5, 1 | 125 |
| F26i | 8, 8, 9, 6, 4, 5, 1 | 41 |

The eight assessed expectations hold 80 findings, 24 conditions (16 of them
the universal R06 and R10 tuples) and 399 citation entries. Rejected oracles
hold only the outcome, stage and reasons; each reason has `documentRef` null.
Manifest coverage lists `F26` plus the targeted R05 key for the receipt cases
and `F26` and `D6` for every loader vector; the universal R06 and R10 keys are
omitted from coverage and kept in every finding.

File totals: F26a holds 9 files (no receipt), F26b to F26f, F26k and F26l 11
each, F26g and F26h 20 each, F26i and F26j 13 each, F26m 15 and F26n 16, for
183 files. Generated recipe outputs and attempted targets are never committed.

### Readings applied

- C06 as amended: a stated order timestamp governs inside the date span
  (F26b); equality with it is not sequenced (F26c); both span ends are
  included (F26e, F26f). Every receipt references the order version and states
  a time, so each is linked and no receipt candidate, `order_receipt_missing`
  or absent order arises. F26b and F26c add the order timestamp to R04 and R05
  citations; R04 still passes because the encounter and order dates differ
  (C02).
- C09: with no receipt at all, F26a holds only `R05.no_usable_receipt`;
  `order_receipt_missing` concerns a usable receipt that fails to link, and
  the order is usable, so `R05.no_usable_order` does not hold. R05 still cites
  the order date.
- F26g (matrix decision, answer 2): the 50-slot bound passes, and the restricted and
  declared unreadable notes keep their R09 conditions. R09 takes the
  restricted status for the authorization coordinator, the unreadable condition keeps its
  own routing, and the parent names both notes (C07). Lineage v2 supersedes v1
  by committed metadata (C08), so v1 is listed as superseded and contributes no
  fact. R02 cites the encounter, order and receipt pairs, the lineage v2 pair
  and the 42 filler pairs (92); restricted, unreadable and superseded notes
  are bound by metadata and not cited.
- Note titles and texts map to no evidence field, so the auxiliary notes add
  identity citations only, with no clinical fact or readiness change.
- Rejected oracles (matrix decision, answer 3) list `rules: ["R09"]` as the required
  provenance reference, with `D6` and the SPEC sections; each `authoringNote`
  explains that the loader owns the rejection before any R09 finding exists.
  The reference transfers no input-boundary authority to R09.
- D6 precedence: count first (F26h, F26m report no size or path reason);
  within the count bound every size reason and at most one path reason, in
  canonical order (F26n). The F26n at-limit payload is a negative control and
  adds no reason (matrix decision, answer 5).
- The path attempt strings are the approved inert `outside-root` labels
  (matrix decision, answer 4). They need no sidecar and are counted as slots; their
  targets are never created or opened.

### Recipes

Pad recipes use placeholder `@@PAD@@` (7 bytes) and fill `é` (two UTF-8
bytes, one Unicode scalar value) inside the note's `text` string. Template
base is the template length minus the placeholder; it is even for the
1,048,576-byte target and odd for 1,048,577. Every value below was recomputed
from the committed template bytes (matrix decision, answer 6).

| Output | Template (bytes, base) | Target | `é` repetitions |
| --- | --- | --- | --- |
| F26i `f26i-large.v1` | `f26i-large.template.json` (419, 412) | 1,048,576 | 524,082 |
| F26j `f26j-large.v1` | `f26j-large.template.json` (404, 397) | 1,048,577 | 524,090 |
| F26m `f26m-large.v1` | `f26m-large.template.json` (402, 395) | 1,048,577 | 524,091 |
| F26n `f26n-large-a.v1` and `f26n-large-b.v1` | `f26n-over.template.json` (402, 395), read by two pads | 1,048,577 each | 524,091 each |
| F26n `f26n-large-c.v1` | `f26n-limit.template.json` (401, 394) | 1,048,576 | 524,091 |

Replicate recipes use a committed 453-byte filler payload template and a
685-byte metadata template with placeholder `@@N@@` twice (document ID and
provenance statement), width 2. Each rendered copy is
`685 + 2 * (2 - 5) = 679` bytes, so a copy with its payload is 1,132 bytes.
Each metadata template writes the payload template's SHA-256 literally as
`contentHash`; rendered IDs `<p>-filler-01` onwards are distinct.

| Fixture | Recipes | Generated bytes (limit 4,194,304) | Audit verifications |
| --- | --- | --- | --- |
| F26g | replicate 42 | 47,544 | 42 |
| F26h | replicate 43 | 48,676 | 43 |
| F26i | pad | 1,048,576 | 1 |
| F26j | pad | 1,048,577 | 1 |
| F26m | pad, replicate 45 | 1,099,517 | 46 |
| F26n | three pads | 3,145,730 | 3 |

Every count is at most 64, every target at most 2,097,152, and no 1 MiB
payload is replicated. Replicate payloads are committed templates (the ratified exception).
The separately labelled recipe pin audit expands all nine recipes, including
those of the rejected F26h, F26j, F26m and F26n, for 136 verifications; the
loader stays count-first and does not expand them.

### Deferrals

- F26a defers to S4 the neutral request for existing receipt evidence; it
  asserts no delivery.
- F26g and F26i defer actual ingestion enforcement of the 50-document and
  1 MiB limits to S4; F26i also defers human acceptance.
- The rejected fixtures state the same S4 ingestion limitation in their
  `authoringNote`. Real-filesystem symbolic link proof stays with the structural
  validation temporary-tree tests, and the version 2 assessment evaluation loads
  the committed fixtures through the same validated loader.
  A path string does not prove that no outside read happened.

### Distinctions from earlier batches

- Migrated-batch F26x1 (a second order without a qualifying receipt) and F26x2 (good,
  conflicting and unsequenced receipts for one order) keep their mixed
  predicates; F26a to F26f each isolate one ordinary receipt case.
- Core-row F05d (an order with neither date nor time) rests on the explicit
  unsequenced predicate with no span; F26d to F26f compute the C06 span.
- F26g's restricted and unreadable notes are counted slots in a count control.
  The isolated R09 vectors stay with core-row F16a and F16c (restricted and
  unreadable encounters) and version-decision F08x4 (notes including an unreadable
  one).

### Pins

SHA-256, computed with `shasum -a 256` from the files at the revision that adds
this section. At that revision `evals/src/frozen-v2-boundaries.ts` was
`1adbf3bab88d499b3a237570cc788ecf95bae42140eb6f61dd4616bfa66e7fc6`; later
comment-only edits change that file hash but no pinned value. The frozen
values are recorded from the files themselves after review.

| Fixture | `manifest.json` SHA-256 | Oracle SHA-256 |
| --- | --- | --- |
| F26a | `e55f3ba7d4592fa15d5ed17d6b7a3badad73d21896de80dab689c6b625faae00` | `6c11811f97422d540f8050ba3667e19374bae6b7df69af216fd39758730fbf6d` |
| F26b | `9e1c088d426efc15dbd39820773d8dd20dd38954841c48cdbd143126b8047236` | `6a46e78943f634c681798ebd0045665da622184a8fae455277d66c3b5f07252a` |
| F26c | `7f79c41e70782e0cf744b04b69c3ba2453cacf0a90aaf9d73f7d791d5a666296` | `5625800b09b99a5241081abc0645306703bf2a3625947a4e2c3e27ef6f6ed522` |
| F26d | `6f144b917014e86aca24e64b6fa7b944a1c563f81dc45278eb0ea6a79a015649` | `5b415e90081b2dc7fe41378e06e78053335b2414892a13c58e4b974bccf0b50b` |
| F26e | `5f6a4f8eaaf2d512fe6aec6034f6cf73bdef2b83537c60d31253c54c82a4c4af` | `c75ab09799bc74694833ae56d78e7a0e42548c642d9dc84aa30713bf2a24e028` |
| F26f | `22d7c5e47a5500ed7414e42f1994c38a615059c61ee2ab52a4d1e2010ef4b30b` | `5acc40806c0d7551a13f165c95d92e85c2eef66f0cb9df78ca8eaa205f019ea3` |
| F26g | `9b9dcde0d2b87c665340aa72f700d1196d0587cd138a8dd2f7ef69cdfebcff1e` | `c82f5902cae5c04a301a808094045bf3363e8f260b3504bc9f5e8202108c89f2` |
| F26h | `5695615b169e90071414fa7b74159b01eb35f4772f5b35e50ee2960a1b8eb805` | `a698d93a0c97ddc1d6a717975537c6950e59fae2fd24748b1f375703ec220c9c` |
| F26i | `db885ea04054279c0d55d75216a74a34e37c6b0703f1623f3f7a92bdbd76e30f` | `d17089dc6e369d0cd11e80f517705b2bc8023480aaa1a103260c8febf0be9e7b` |
| F26j | `88147a574cc8a8140179ef788157b59bba5fdbda8053b2dfc8681c78775bc4b8` | `bed7bcfd96a3deab977de002424212b7b2df072f78d636b21eda9625e98e04ea` |
| F26k | `154e54562dfb33ca99677f830fbde3ac78af3cf05316c9481f23f949d74bfd25` | `1e1582eea7bca897d6ed6979efc34af2aaf4bc1b9680b1232b03c6040497590d` |
| F26l | `23ea1692417c389f986bdf20888f2aa37eefdf84bcf3ba35756ea50dbda0d4e0` | `ef403d0f8c39f47c063049f41ae49b9ade4085b2439bbaacdbba4fefdc8b8aff` |
| F26m | `1b03163e5993ccc3811e99db3ea576104acfdc1f42f8bb99fe8ebf931d20bb50` | `61cc87f7df3c8cbdf977a6b690b5a6bc1620071897d6cc0c77b86df27dd4d3d8` |
| F26n | `3e7721fec3842bbc6897594b21ed55bcd62f3c56152a858995dba5b4c4417fd9` | `66074665b1c52c42c390de78455f2ad923e962a1b9113c5a30d0e8bd1e5c7b91` |

### Authoring helpers and independence

A scratch helper in the system temporary directory, never committed, wrote the
bytes. It serializes a hand-written selection list of source values, recipe
parameters and per-rule statuses, roles, conditions, parent sets, citation
lists, states, rejection reasons, rationales and deferrals; computes SHA-256
values; renders pad and replicate outputs in memory to pin them; and formats
citations and manifests. It decides no usability, binding, supersession,
chronology, status, condition, parent set, reason or state; it only asserts
the canonical order of hand-written references and the parity and
reachability of each pad target. One template text (F26i) was adjusted by
hand to give the even base its target needs. A second scratch check parsed
every input, including in-memory recipe outputs, with the public v2 contract
schemas only, and confirmed that every sidecar and body is valid, every
payload matches its `contentHash` and kind, every beneficiary is case-bound and
the restricted note has no payload. The helper, selection list and check are
disclosed to the independent oracle reviewer. Earlier
batches' fixtures and oracles were read for format only. The author did not
read domain code, the assessment harness, harness
output or domain tests.

### Coverage and gaps

- The registered union is 95 fixtures (82 assessed, 13 rejected) across six
  batches.
- The loader-owned `input_boundary` codes `document_count_exceeded`,
  `path_outside_root` and `document_size_exceeded` now have committed
  vectors, including the combined-invalid precedence cases.
- `R09.locator_unresolved` remains uncovered by every registered batch (S6).
- This batch runs no assessment. The version 2 assessment compares results; ingestion enforcement,
  requests and human acceptance remain S4.
- Structural validation was exercised on macOS only.

## Version 2 assessment inputs

The pure input stages of the version 2 assessment live under
`packages/domain/src/v2/`. It parses raw bytes with the exact contracts,
rejects at the schema and snapshot integrity stages, applies trusted lineage
and classifies every supplied version. These stages expose no rule
predicate and no assessed outcome or state of their own. The legacy `assess`
entry point, its gate and every frozen byte are unchanged. The rules and the
complete result (`assessV2`) build on these stages, and
`evals/src/v2-scoring/assessment.eval.ts` compares them with the registered
union.

### Adapter

The input is raw `caseBytes`, `policyPackBytes`, the explicit `assessmentDate`
argument and documents carrying the loader's opaque `slot`, `metadata` bytes and
`payload` bytes or `null`. It is an adapter shape in `packages/domain`, not a
contract or persisted format. Identity comes only from the metadata. The slot
appears only in rejection paths.

The adapter contract requires loader-approved bounded input. It requires
unique slot labels in the logical pointer grammar, at most 50 supplied
versions and payloads of at most 1,048,576 bytes each. There is no aggregate
limit. The domain never emits `input_boundary` reasons: a caller that breaks
the contract gets a content-free `RangeError` or `TypeError` before any byte is
parsed. That is a caller defect, not a rejection. The loader remains the only
owner of `input_boundary`, and S4 repeats the bounds at ingestion.

### Stages

1. **Schema.** `CaseV2`, `DocumentExact` per sidecar, the pack check below and
   `IsoDate` for the argument run together. Every reason is reported in
   canonical order. A sidecar reason names the metadata identity only when
   both `documentId` and `version` parse. A mismatch is judged only when both
   the case and the argument are valid.
2. **Snapshot integrity.** Duplicate, restricted-with-bytes and missing-bytes
   checks always run. The supersession checks run only without duplicates.
   Under the cross-document reference decision (answer 4), a reference to another document ID rejects whether
   or not that target is supplied. Kind and subject are compared for every
   supplied target, including the target of a cross-document reference; an
   absent target is not compared. Two subjectless supplier records may
   supersede each other.
   An edge that changes both kind and subject gets both reasons.
3. **Lineage.** Every supplied target of a `supersedes` edge is superseded,
   whatever the superseder's own usability. An absent target has no effect.
4. **Classification.** Each version is classified before any rule reads a
   body. A metadata subject other than the case's quarantines it on
   `binding.metadata_subject` without reading or hashing the payload. Otherwise
   R09 takes its first condition in the order `access_restricted`,
   `hash_mismatch`, `access_unreadable`, `mime_unsupported`, `body_invalid`,
   `kind_mismatch`. A verified body then binds only when every stated
   beneficiary identifier and name equals the case's exactly; supplier records
   are exempt. Only a usable current version keeps its exact body and values.
   Quarantined, unusable and superseded versions keep their metadata identity
   only. `R09.locator_unresolved` is never emitted.

Exact extraction reads every non-null value at each evidence locator from the
source text. A string keeps its surrounding whitespace, and a number keeps its
token as written (`1.0`).

### Pack coverage

This records the D6 pack coverage clarification.
`EVALUATOR_INVENTORY_V2` declares, per rule, every status the evaluator can
select and every condition it can emit. Each condition carries its owning
status, qualifier, emitted field values, document arity and named kinds. The
inventory also states the routing the evaluator relies on: R06
`manual_review` goes to the qualified clinical reviewer with effect `none`, and
R10 `not_applicable` has effect `none`. It is internal metadata, written from
the condition vocabulary above, and never an output field. It holds 61
condition keys: the pack vocabulary without `R09.locator_unresolved`.

The pack check returns at most one reason, in this order:

1. a pack that is not a valid `pa.policy-pack.v2` is `policy_pack_invalid`;
2. a valid pack missing one of R01 to R10 is `policy_pack_incomplete`;
3. a valid complete pack that does not cover the inventory is
   `policy_pack_invalid`.

A pack covers the inventory when every supported status has an outcome
satisfying its routing. Every supported condition must also be declared under
its owning status, with the same qualifier and arity, every emitted field value
and every named kind. Extra declarations are allowed. The reason is
content-free and names no rule, status or key.

The backstop is an internal seam. It runs only after schema and integrity
have passed. An evaluation can fail by emitting an unsupported or undeclared
status or key, a pass condition, or an incompatible field, arity, kind or
duplicate reference. It can also leave a rule with no selectable outcome. In
each case the seam discards everything and returns the single
`policy_pack_invalid` rejection at the schema stage. It never throws, drops a
condition or makes a pass. Part B must exercise the same contract through
`assessV2` and keep the seam out of the public exports.

### Purity guard

`boundaries/pure-domain-globals` extends the domain lint boundary.
`globalThis` and `crypto` are permitted only as
`[globalThis.]crypto.subtle.digest(...)`, and `Math` only through a static
member name. An alias, destructuring, computed or other use of them fails. The
members `random`, `randomUUID`, `getRandomValues`, `getTimezoneOffset`,
`resolvedOptions`, `localeCompare` and the `toLocale*` family fail by dot or
bracket access or as a destructuring key. The browser and Node global objects
(`window`, `self`, `global`, `document`, `location`, `top`, `parent`, `frames`,
`opener`) are banned, along with `eval`, `Function`, `Reflect`, `Temporal` and
`import.meta`. The member name `constructor` also fails by dot or bracket
access or as a destructuring key, because any function value's `constructor`
is the Function constructor; a class `constructor` method is permitted.
`evals/src/domain-purity.test.ts` lints 46 escapes and 7 permitted forms as
in-memory probes under three parser setups, and the real `hash.ts` with full
type information. Computed access with a key built at run time, on a value the
guard cannot trace to a global, is not statically decidable. This is a static
engineering guard, not a sandbox.

### Tests and limitations

- Direct-input tests in `packages/domain/src/v2/*.test.ts` use synthetic
  builders (`packages/domain/test/builders-v2.ts`) and read no fixture, oracle
  or pack file.
- `evals/src/v2-pack-coverage.test.ts` reads the pack and the F15 negative
  input at their core-table paths and checks their pins. It then checks
  coverage through the domain helper.
- `supersession_cycle` is unreachable: every valid edge points to a strictly
  earlier version. The absent cross-document target is decided by the cross-document reference decision,
  not by a frozen oracle.
- A superseded restricted version still blocks this snapshot through R09.
  Lineage over one snapshot proves no arrival order or recovery (S4).
- These input stages do not run the registered union. The 95-fixture
  comparison and its false-ready figure come from
  `evals/src/v2-scoring/assessment.eval.ts` in `pnpm test:evals`.
