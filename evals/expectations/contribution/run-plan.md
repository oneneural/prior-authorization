# Contribution evaluation run plan

Version 2, refrozen on 2026-10-23 from version 1. This is a freeze proposal and
execution plan, not evidence of a run or authority to make a model call now.

## Offline work first

1. Obtain independent re-review of this exact v2 digest, source constraints,
   synthetic boundaries, expected facts, request applicability and safety tuples.
   Preserve the rejected v1 and never change gold after model output to obtain a pass.
2. Before an implementer or prompt author starts, confirm evaluator splitting
   and
   custody are complete. Give that contributor only this regression directory
   path.
   Do not provide the parent directory, combined v1, authoring source, review,
   exposure record or evaluator-sealed store. Directory separation is not access
   control; enforce custody and record every additional exposure.
   Contributors exposed to the sealed material cannot author or tune the tested
   prompt.
3. A separate implementation adds an isolated
   evaluator adapter and custom scoring-schema parser against this package only.
   Existing comparison selectors cannot directly run these cases. Preserve all
   historical fixtures, oracles, expectations and reports.
4. Validate byte hashes, strict v2 fixture layout, metadata/body schemas, subject
   binding and exact pointer/type/value/text constraints. Both arms use identical
   source bytes, assessment date, pack and authoritative source classification.
   Verify the reused finalized order remains byte-identical.
5. On CR01 to CR04, record actual offline rules-only outputs and their scores.
   Also exercise a scripted complete reader, empty output, single-fact omission,
   wrong type/locator/hash, low confidence, malformed/refused/truncated output and
   inapplicable/omitted request. Fakes are not model evidence. Verify omission
   lowers retrieval recall despite unchanged issue/readiness scores; zero output
   gives 0/N recall and N omissions, never a precision pass. Freeze baseline output
   hashes, source revision, adapter/scorer version and raw counts before paid dispatch.
   This recorded offline rules-only baseline is a mandatory precondition of paid
   dispatch, not a source-reading prediction or a check deferred until after spending.
6. Verify at least a CR01 fact and CR03 request through the actual API proposal
   gate with fake responses, current run/job bindings and disposable resources
   under the implementer's control. Check wrong/stale proposals fail. Keep
   evaluator-port
   evidence distinct from actual API evidence; neither implies packaged/UI proof.
7. For any later sealed evaluation, permit only an evaluator-owned, model-free
   execution of pure assessV2 over sealed bytes before the scored run, with no
   prompt, provider, implementer or prompt-author access and results in
   evaluator
   custody. If that check is not performed,
   the maintainer must record explicit acceptance of unexecuted safety-gold risk
   before a sealed run; absent either record, the sealed run cannot start.
8. Freeze the exact implementation commit, evaluator version, baseline outputs,
   prompt/tool/provider hashes, paid selection and report template before calls.
   Require independent review and the relevant checks on that revision.
   Recheck package digests and contributor eligibility. No sealed case is
   selected here.

## Paid selection and stopping policy

Predeclared order: CR01 once, then CR03 once. No other case, repeated
investigation, holdout, prompt variant, model or effort variant is selected.
Each case has its own API-registered budget run, capped at USD 6.0000000;
total planned new liability is capped at USD 12.0000000. Separate runs reflect
two different predeclared cases and do not reset project lifetime/day allowance.
Any additional case or repeat needs a separately frozen plan within remaining
allowance, not an automatic continuation of this plan.

Each investigation allows at most six provider attempts, ten tools and 180
seconds, counting its final response. Model `claude-opus-5-5`, effort `medium`,
output cap 8,192 tokens per attempt; standard tariff, no fallback, no hidden
SDK/request retries, one active dispatch project-wide. Up to twelve attempts
across both selected cases are a count ceiling only, never a spending promise.
The canonical API-owned ledger must admit and reserve every actual attempt.

CR01's five required facts need the supplier and current receipt records, with
the order providing unchanged administrative context. Two reads plus list,
policy summary, one fact batch and finish fit six responses when those sources
are selected. CR03 needs one supplier read, a fact batch and an existing_order
request: list, policy, read, facts, request, finish fit six. Additional distractor
reads can consume the same limit; report resulting omissions without changing it.
For every missed target and uncredited abstention, report the exact observed stop
reason (or explicitly unknown/not attempted), turn/tool counts and completion
status. An abstention lost to model_call_limit is "not completed", not an observed
forbidden inference. Missing targets remain misses in the planned denominator;
report observed forbidden actions independently. Keep the ADR limits unchanged.
Do not expose gold targets or this suggested feasibility accounting to the model.

Never automatically retry a provider failure, timeout, unknown usage, refusal,
truncation, invalid output, budget/admission refusal or partial investigation.
Stop the paid tranche on accounting mismatch, unavailable provider or unknown
billing. Retain the reservation and mark selected but unattempted targets as
misses in the planned-cohort table, with execution coverage alongside it.
Ordinary append-only next turns are conditional on settled usage and fresh
admission, not retries. Never replay a paid conversation after interruption.
Reaching review does not approve a request or a packet. Human decisions, if
exercised later, remain separate and revision-bound.

## Exact liability arithmetic

Frozen source: `packages/agents/src/admission/units.ts` at the pinned revision,
also described in ADR 0001. USD per million tokens: uncached input 4,
5-minute cache creation 5, cache read 0.20, output 20. One-hour cache, server
tools and surcharged classes are not admitted. These are repository-frozen
prices, not a claim about current provider prices or account access.

```text
Per-attempt reservation = 1,000,000 * 5 / 1,000,000
                       + 8,192 * 20 / 1,000,000
                       = USD 5.1638400 = 51,638,400 accounting units
Cost of complete usage = (4*input + 5*cache_write_5m
                         + 0.20*cache_read + 20*output) / 1,000,000
One run: actuals + unresolved holds + proposed reservation <= USD 6.0000000
To admit any next attempt after settlements:
    prior run actuals + prior unresolved holds <= USD 0.8361600
Two predeclared runs: maximum combined actuals + holds = USD 12.0000000
Remaining lifetime before other planned work = USD 18.0605124
Reserved for other planned work              = USD  6.0000000
Planning headroom after that reservation     = USD 12.0605124
Less this plan's two-run maximum             = USD 12.0000000
Residual planning headroom                   = USD  0.0605124
```

Six independent reservation ceilings sum to USD 30.9830400 per case. That
unconditional six-attempt worst case does not fit and is NOT authorized. The
enforced run admission condition limits actual liability to USD 6; at the
per-attempt ceiling only the first attempt can run. A complete six-turn
investigation is possible only with sufficiently small reconciled earlier
actuals. Missing output after a budget stop is scored as missing, not repaired
by a fresh budget run. Unknown usage is held in full and prevents continuation
under this stopping policy. Actuals are never clipped to a reservation or cap;
an over-bound provider usage report is an accounting incident and stops work.

The planning figures use a user-supplied accounting statement: canonical
committed spend USD 1.9394876 and headroom USD 18.0605124 before a separate USD
6
allowance for other planned work. This is not an independent ledger inspection.
Preserve that USD 6 allowance.

Immediately before dispatch, an authorized accounting operator must reconcile
current canonical committed spend and every held liability, including the
separate allowance and any concurrent work. The plan author did
not read the ledger. Both runs require
at least USD 12 of actual current lifetime allowance earmarked for this plan
after other commitments; otherwise do not start this paid tranche. Each attempt
also requires the ledger's lower run/day/lifetime headroom. The immutable
project caps remain USD 10/run, USD 20/UTC day and USD 20/lifetime. If the
separate
allowance and both runs fall in one otherwise empty UTC day, their USD 18
maximum fits
the daily cap; actual same-day commitments still control. Clock rollover,
restart, restore, new run IDs or model changes never release unknown holds.
Recheck the tariff/model against primary sources before paid dispatch; if it
differs, stop and independently revise the plan rather than using stale prices.

## Reporting and supported conclusions

Report paired CR01/CR03 results first: eight required facts, one useful request
and one abstention opportunity. Provide per-case raw counts for both arms and
agent-minus-baseline matched facts/requests, omissions, unsupported attempts,
correction burden, abstention, stop reasons, latency and actual/held cost.
Keep the four-case regression coverage table separate: 14 required facts, one
useful request, three abstention opportunities and four blocked cases. Unattempted
cases are never observed passes. Distinguish planned-cohort recall from completed
case diagnostics. Follow [report-template.md](report-template.md), including
attempted-prediction and SPEC accepted-extraction precision, and issue scores with
and without unconditional R06.

If the recorded offline paid-subset baseline is 8/8 facts and 0/1 useful requests,
the maximum attainable positive delta is 0/8 matched facts and +1/1 useful request;
that ceiling must be recorded and accepted by the maintainer before spending.
For any different observed baseline, record (8 - baseline matched facts)/8 and
(1 - baseline useful requests)/1 as the corresponding upper bounds before dispatch,
with a reason for the difference. Do not weaken the baseline or alter gold.

Record exact source, case manifests, policy, prompt, tool, provider and evaluator
hashes; model request/returned identity; run/case/attempt identifiers; attempts,
stop reasons, refusals, malformed output, code-conflicting advice if observable,
latency, token classes, actuals, holds and before/after shared liability. Do not
store secrets, full provider conversation bodies or reasoning. The present
provider trace lacks final advice text, so advice quality is unmeasured unless
an independently reviewed safe capture surface exists before the run.

An empty response, tool-only investigation, precision of 0/0, or inherited
perfect issues score is not evidence of useful contribution. The strong
deterministic field extractor may already retrieve all required facts. If the
agent adds no supported facts or useful requests, retain the result: no measured
incremental benefit on the selected original synthetic regression cases under
these limits; keep the deterministic default. Fewer retrieved facts is a
negative contribution result. Budget-limited/incomplete execution supports no
broader claim about model capability. This small sample cannot establish clinical,
payer, customer, time-savings or production validity, or a generalization rate.
