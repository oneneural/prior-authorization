# Local fixture adapter

This page records what the packaged demo's connector boundary actually does.
Every exchange here is `scripted_fixture`: local reads of packaged synthetic
files and local database writes. Nothing is transmitted, and no payer, EHR,
FHIR server or external account is involved.

## Boundary

| Operation | Implementation | Label |
| --- | --- | --- |
| List document versions | `GET /api/cases/:caseId/documents` returns the metadata of every stored version of the current revision | local read |
| Read an exact version | `GET /api/cases/:caseId/documents/:documentId/versions/:version` returns the stored bytes after the subject, hash and access checks; a withheld or unreadable source is a 404 | local read |
| Load the reviewed policy | `GET /api/cases/:caseId/policy` returns the policy pack bytes bound to the revision with their SHA-256 | local read |
| Simulated request | A neutral draft from a fixed template, approved locally by the operator; the worker records one local receipt in the same transaction that marks the request `simulated_delivered` | `scripted_fixture`, nothing transmitted |
| Fixture reply | `archive_f01` or `archive_f05b` appends existing finalized archive versions and queues reassessment (see [the fixture README](../../packages/connectors/fixtures/README.md)) | `scripted_fixture` |

Inputs come only from the fixed registry in `packages/connectors`: the five
seeded fixtures, the F05b archive and the reviewed lab policy subset. The
loader refuses caller paths, symbolic links and oversized files. The image ships
these files and the recorded agent responses under
`packages/agents/recordings`, never the evaluator oracles or expectations in
`evals/`.

## Observed proof

`scripts/demo/smoke.sh` exercises the boundary through the web BFF and checks
each hash. These values come from its runs on this branch; they are
deterministic for the packaged fixtures:

- Case `case-f02-loop` (F01's synthetic subject with its order and receipt
  withheld) reports R03 `missing`.
- Request content hash
  `2470c9b11b5e2d50efec21d99d501bc973231eb12143ae2f35d2d9de9d6a1a65`, approved
  by the fixture operator; exactly one local receipt with the same content hash
  and mode `scripted_fixture`.
- After the `archive_f01` reply, revision 2 is ready for administrative review.
  The packet hash is `5eb68dea6c55...`, and every readable source version hashes
  to its recorded `contentHash` (for example `f01-order@1` to `60668dad9d3a...`).
- The policy text hashes to the `policyPackSha256` bound to the packet
  (`0792ccad775e...`).

## Limitations

- FHIR, DTR, PAS and X12 exchanges and reference servers are outside the
  implemented adapter. Profile validation and payer transport would be
  separate work.
- No PAS or payer response is fabricated: a fixture reply is an existing
  finalized archive document, never a decision.
- Real connectivity (payer, EHR, messaging) needs separately authorized scope
  and access. Nothing here claims that it works.
