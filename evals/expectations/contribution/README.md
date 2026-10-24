# Regression contribution package

Version 2 of the synthetic regression package, refrozen on 2026-10-23 from
version 1 after independent review.

- [Case fixtures](../../suites/contribution/fixtures/) contain CR01 to CR04 only, in the existing v2 fixture format.
- [expectations.json](expectations.json) holds only regression gold.
- [scoring-contract.json](scoring-contract.json) defines shared scoring semantics.
- [run-plan.md](run-plan.md) predeclares offline prerequisites and paid selection.
- [report-template.md](report-template.md) requires raw counts and evidence limits.
- [SHA256SUMS](SHA256SUMS) covers every package file except itself. It also lists
  two authoring tools, `validate_artifacts.py` and `source-inventory.json`, that
  are not part of this repository.

| Case | Purpose | Required facts | Useful requests | Abstentions |
| --- | --- | --- | --- | --- |
| CR01 | Fragmented supplier/receipt records with distractors | 5 | 0 | 0 |
| CR02 | Restricted receipt and unreadable cover | 3 | 0 | 1 |
| CR03 | Missing existing order and neutral request | 3 | 1 | 1 |
| CR04 | Conflicting supplier exemption status | 3 | 0 | 1 |
| Total | Four blocked administrative cases | 14 | 1 | 3 |

Source payload bytes are unchanged from version 1. Only CR04 manifest labels
change to F10, with its manifest hash regenerated. Required facts, request gold,
abstention gold, safety gold and denominator values are preserved. Neutral
inapplicable request strings move intact to inapplicableRequests for utility-only
scoring. Other added fields specify scoring metadata, not new gold values.

All material is original synthetic administrative composition. Existing finalized
F01 order and sidecar bytes are reused unchanged where present. No order, medical
note, diagnosis, signature, encounter body or medical-necessity statement was
authored or altered. Shared synthetic lineage and no clinical review are disclosed.

Give an implementer or eligible prompt author only this directory. Prompts may be
designed against regression work, but runtime/prompt text must never import or
embed these files or gold; the evaluator exposes selected evidence through the
normal scoped port. Keep evaluator source, gold and runner out of runtime imports
and image builds. The fixtures and expectations live in evaluator-only paths
outside runtime code.

Run `pnpm test:contribution` from the repository root to verify the package and
the rules-only baseline. It checks every SHA256SUMS line for a file in this
repository. No model call is required.
