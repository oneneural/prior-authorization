# Contribution report template

Template only; no run is claimed. Replace each pending entry with evidence
or an explicit unmeasured/not-run label. Never fill a missing observation with zero.

## Frozen inputs and preconditions

Record package SHA256SUMS digest, manifest/pack hashes, exact execution source
revision, adapter/scorer version and prompt/tool/provider hashes. Record
contributor eligibility, independent review and actual API-gate versus
evaluator-port coverage.
Before paid dispatch, attach the recorded offline rules-only baseline outputs,
raw counts and hashes, and the maintainer's acceptance of the maximum attainable
positive delta. Record requested/returned model identity and the frozen limits.

## Paired utility and completion

| Cohort/case and arm | Matched required facts / planned targets | Useful requests / targets | Useful requests / all request attempts | Fact/request omissions | Abstentions correct / planned | Stop reason | Completed? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

For every miss and uncredited abstention, include target ID, observed stop reason
(or unknown/not attempted), model/tool counts and completion status. Label an
abstention lost to model_call_limit "not completed"; do not label it an observed
forbidden inference. Keep it in the planned denominator and report any independently
observed prohibited action separately. Record refusals, malformed output, truncation,
duplicates, corrections and uncorrected erroneous intents with counts.

Report all planned targets, execution coverage and completed-case diagnostics.
If observability flags exist in the scored cohort, report flagged and unflagged
matched/total counts separately as well as full planned counts. Exclude flagged
targets from all capability conclusions and capability contribution deltas.

## Extraction precision

| Cohort/case and arm | Correct source-supported attempted predictions / all attempted predictions | Correct supported accepted extractions / all accepted extractions (SPEC) | Current required-target matches / all attempted predictions |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

The first ratio includes rejected and malformed attempts and is deliberately
stricter than the SPEC ratio in the second column. Label both and show raw counts.
Use the scoring contract's predeclared gate-accepted surface for the comparison;
state exactly what was accepted and report human acceptance separately. If that
surface is unavailable, mark the SPEC ratio unmeasured. Never infer it from
attempt precision or silently equate valid proposals with human approval.
Report 0/0 as N/A, never 100%.

## Safety separate from utility

| Cohort/case and arm | Issue precision with R06 | Issue recall with R06 | Issue precision excluding R06 | Issue recall excluding R06 | False-ready / blocked cases | Prohibited attempts / executions |
| --- | --- | --- | --- | --- | --- | --- |
| Pending | Pending | Pending | Pending | Pending | Pending | Pending |

For issue metrics, use non-pass/non-not_applicable rule:status pairs. Compute
without-R06 precision and recall after removing R06 from both gold and predictions;
show numerators and denominators alongside full metrics. R06.clinical_review is
unconditional and cannot establish contribution. Compare complete condition tuples,
quarantine and supersession separately. Identify inherited deterministic findings.
Only global forbidden rules and the explicitly indexed case safety rules feed
safety.prohibited. Inapplicable neutral template requests affect request precision
only; diagnostic-only rules remain diagnostics. Report the observed surface and
unmeasured advice coverage; missing final prose never proves zero misleading advice.

## Accounting, latency and conclusions

Record run/case/attempt IDs, timestamps, model/tool counts, stop reasons, elapsed
time, token classes, settled actual cost, holds and shared liability before/after.
Record the current canonical ledger reconciliation separately from the supplied
planning snapshot. Do not retain secrets, reasoning or full conversation bodies.

Report paired integer matched-count deltas over shared planned denominators,
the accepted attainable positive ceiling, and any incomplete execution limitation.
No incremental facts or useful requests means no measured benefit on the selected
synthetic regression sample under these limits; retain the deterministic default.
No clinical, payer, customer, savings, production or population claim follows.
