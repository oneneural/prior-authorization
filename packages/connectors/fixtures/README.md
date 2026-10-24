# Runtime synthetic inputs

These are original authored synthetic source bytes from the first policy slice,
migrated case metadata from the version 2 suite, and the reviewed local policy
subset. Copied unchanged
from the frozen version 2 evaluator fixtures F01, F02, F08a, F23 and F28a and
`policy-packs/lab-k0823-jd-20261018-v2.json` for runtime use.
No evaluator code, manifests, expected results or answer keys are packaged here.
Source metadata retains the original provenance and hashes. Nothing is a real
record, authenticated signature, clinical conclusion or payer submission.

The loader accepts only this fixed registry. There is no arbitrary upload or
caller-selected filesystem path. Policy text is an authored lab subset with its
own source links and limitations, not a complete payer policy.

## Local fixture reply events

`archive_f01` reads the existing finalized F01 order and supplier receipt.
`archive_f05b` reads the existing finalized F05b order and supplier receipt.
The latter source set and its case metadata were copied byte for byte from
the frozen version 2 evaluator fixture F05b (without its manifest) for the local
workflow conflicting-date branch (F24 behavior).
Neither event imports evaluator code, answer keys or expectations. No order or
encounter source is generated or amended by the request workflow.

The API checks the archive subject against the persisted case, appends only
new order and receipt versions, and queues fresh assessment. F05b is an
archive-only registry entry, not an additional default seed. Both events are
`scripted_fixture`, with no external delivery. Cancelled cases retain replies
as audit evidence without importing them into current evidence.
