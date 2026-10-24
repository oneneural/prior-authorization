# Packaged live agent and shared spend admission

Status: accepted and implemented on 2026-10-22, with independent design review.
This record does not by itself authorize a model call. The design text below
describes the decision; implemented names and confirmed decisions are listed
under [Implementation record](#implementation-record). The design was reviewed
against [SPEC](../../SPEC.md) SHA-256
`ccd0f9e01eb5066005c57387a4391bb52525faf3349d4c5a09f7f406002719d3`.
The original project caps (USD 10 per run, USD 20 per UTC day and USD 20
lifetime) are preserved.

## Implementation record

Names as implemented:

| Design term | Implemented name |
| --- | --- |
| Canonical ledger schema | `pa.accounting-ledger.v2` (migrated from `pa.anthropic-spend.v1`) |
| Total cap configuration | `AGENT_TOTAL_BUDGET_USD` |
| API-only ledger location | `PA_ACCOUNTING_LEDGER_FILE` |
| Evaluation admission auth | `PA_EVALUATION_ADMISSION_TOKEN` or `PA_EVALUATION_ADMISSION_TOKEN_FILE` (API), the token file for the CLI |
| CLI admission identity | `PA_ADMISSION_API_ORIGIN`, an exact loopback origin |

Decisions confirmed during implementation:

- After a container crash, the recreated API cannot prove its predecessor
  stopped (a different process namespace), so the lock stays and admission
  stays closed until an operator runs the maintenance `recover` command.
- The evaluation CLI is admitted by a host-run live-mode API, because the
  packaged API listens on loopback inside its container.

## Verified facts and accounting snapshot

On 2026-10-22, accounting metadata was read from the existing ignored local
JSON spend ledger, schema `pa.anthropic-spend.v1`.
No credential file was opened. The snapshot SHA-256 is
`9e2298dbd110d7679f8ac5aad2acc8d267eeb7526143ae7cd35c6be79d583174`.
This identifies the inspected ledger, not a replacement ledger or a Console bill.

| Reconciliation item | USD or count |
| --- | --- |
| Reconciled spend, all runs | USD 1.9394876 |
| Reconciled reservations / recorded calls | 133 / 133 |
| Smoke run | 5 calls, USD 0.0987340 |
| Full run | 128 calls, USD 1.8407536 |
| Open `reserved` entries | 0, USD 0 held |
| `unknown_usage` entries | 0, USD 0 held |
| Conservative committed lifetime amount | USD 1.9394876 |
| Lifetime cap / remaining headroom | USD 20 / USD 18.0605124 |
| 2026-10-21 UTC committed / daily headroom | USD 1.9394876 / USD 18.0605124 |
| 2026-10-22 UTC committed / daily headroom at inspection | USD 0 / USD 20 |
| Maximum per run | USD 10, reducible for a particular run |

The inspection checked unique reservation IDs, reservation UTC dates, complete
usage on reconciled entries and recomputed each actual at the recorded Opus 5.5
prices. Stored `committedUsd` is `1.9394876000000005`; the decimal sum of stored
actuals is `1.9394875999999999923`. This is floating-point serialization residue,
not missing spend. Both round to USD 1.9394876 at the USD 0.0000001 precision
implied by the recorded per-token tariff. There is no detected accounting inconsistency
in this snapshot. The implementation must use exact decimal/integer arithmetic
and round reservations upward. The USD 30.993765 sum of historical reservation
ceilings is not additional spend: all 133 were reconciled, with their original
ceilings retained.

Effective new allowance is the minimum of remaining lifetime, relevant UTC-day
and run allowance, after holding all open/unknown reservations. A new run, day,
milestone, image or model never resets lifetime spend. Reread and reconcile the
canonical ledger before later verification. Missing, changed without explanation
or inconsistent accounting blocks live work while offline work can continue.
This metadata reconciliation does not establish account credit, account-wide
limits, current model access or absence of unrelated account usage.

The [full live report](../../evals/reports/live-claude/2026-10-21-full.md)
records 22 synthetic cases. Its evaluator port mirrors API
validation; it does not invoke the packaged API. Its 49/49 issue results inherit
rules, and its 223/223 accepted facts match deterministic extraction. These are
historical results, not proof of packaged live operation or incremental benefit.

## Actual path and required changes

All paths below refer to the inspected source. Function names are navigation
anchors, not a claim that their behavior was exercised in this task.

| Boundary | Current implementation | Required live behavior |
| --- | --- | --- |
| Operator UI | [AgentPanel](../../apps/web/components/agent-panel.tsx) offers only a recorded investigation, with a fixed recording ID; [command helper](../../apps/web/components/command.ts) sends the event ID | Offer explicit live selection only when API capability permits it; show actual mode, stop/failure and budget status. Never silently substitute a recording |
| Web BFF | [Case route](../../apps/web/app/api/cases/[[...path]]/route.ts) uses [caseApiPath and forwardToApi](../../apps/web/lib/upstream.ts) to forward allowlisted commands, session cookies and checked origin to fixed loopback API | Keep the same authenticated case command boundary, without a provider key or a browser-callable spend endpoint |
| API admission | [Routes](../../apps/api/src/agent/routes.ts) check `actorOf(..., 'agent_run')`. [startAgentRun](../../apps/api/src/agent/service.ts) refuses `anthropic` before lookup; recorded runs use `command`, expected revision and binding, then insert run and enqueue in one transaction | Admit an authorized live run with a server-owned cap/version, current case/source/policy/packet binding and durable job. Queue admission alone does not authorize an SDK request |
| Worker startup and queue | [main](../../apps/worker/src/main.ts) opens checkpoints only for `recorded`; [startWorker](../../apps/worker/src/worker.ts) consumes the agent queue only in that mode. [enqueueAgentJob](../../packages/db/src/queue.ts) sets `retryLimit: 0` | Enable the queue/checkpointer for explicit live mode too. Keep automatic model/job retries off and separate review-only jobs from provider construction |
| Worker scope and provider | [processAgentJob, selectProvider and apiToolPort](../../apps/worker/src/agent.ts) claim the active job through API. The `anthropic` branch forces total budget zero, an in-memory ledger and an unavailable client | Replace that refused branch with shared admission and the file-keyed client. Never use `MemoryBudgetLedger` or a per-container file ledger for real calls |
| Graph and Claude | [graph](../../packages/agents/src/graph.ts) runs agent/tools/review/finalize; [provider](../../packages/agents/src/providers/anthropic.ts) uses Messages API and [five strict tools](../../packages/agents/src/providers/live-tools.ts) | Every Messages attempt must have a durable spend reservation and single-use dispatch grant before network I/O. Keep model input untrusted and business authority outside the provider |
| Actual proposal gate | [recordProposal, validateFact and validateRequest](../../apps/api/src/agent/service.ts), reached via `/internal/worker/v1/agent-runs/:runId/jobs/:jobId/proposals`, enforce active job, current binding, exact source version/hash/kind/locator/value/text, confidence and fixed request applicability | Use these actual routes in packaged proof. Retain run/proposal-key payload deduplication and all rejection reasons; the evaluator's similar gate is insufficient |
| Human review | [AgentReview](../../apps/web/components/agent-review.tsx) submits choices. API `reviewAgentRun` checks reviewer role at the route and only accepts validated proposals, persists the review event and queues resume | Preserve explicit review. `recordAwaitingReview` must accept a live identity only when it matches the admitted run and recorded attempts; it currently rejects anything except recorded identity |
| Apply and recovery | API `completeAgentRun` rechecks binding, marks stale candidates and reruns rules for comparison. Requests become ordinary drafts requiring separate local approval. [PostgresSaver](../../packages/agents/src/checkpoint.ts) stores graph checkpoints; `cancelAgentRun` detaches stranded jobs | Resume a persisted review interrupt without constructing a model client. Revalidate current inputs and API authority. A checkpoint never restores stale readiness, clinical authority or payer approval |

The existing internal transport retries transient API tool calls at most twice;
proposal retries keep the same key and payload. That is distinct from a provider
attempt. Model retries, fallback models and a tool runner that hides extra
Messages calls remain disabled. Cancellation fences later results and proposals;
it does not refund a request already dispatched.

### Inventory of live entry points

The source search before implementation found one actual SDK Messages
operation, `sdkLiveClient` in the provider, used through
`createAnthropicProvider`. Its production callers were the then-refused worker
selection and
[runLiveEvaluation](../../evals/src/live-claude.ts). The latter is invoked by
[live-claude.live.ts](../../evals/src/live-claude.live.ts), selected only by
`pnpm test:evals:live` in [package.json](../../package.json) and
[Vitest configuration](../../vitest.config.ts). It used `FileBudgetLedger`,
synthetic evaluator tools and an in-memory graph checkpointer, not the API.
No separate paid model operation was found in `scripts/`.

Both callers now use the same admission port. The CLI keeps its evaluator
tools and independent expectations but registers a run in the same project
account, with the same attempt protocol and caps. Its old
`PA_ANTHROPIC_LEDGER_FILE` is migration input only, never an alternative empty
live account. Actual SDK construction accepts no caller-selected file or memory
admission; only the API owns the canonical file ledger. Fake implementations
stay explicitly offline. A source/import guard and fake-client checks enumerate
every SDK call site and check that no worker, CLI, recovery or explicit retry
bypasses reservation. This is an
application invariant, not protection against arbitrary programs using the key.

## Decision: one canonical API-owned accounting ledger

Evolve the existing `pa.anthropic-spend.v1` JSON ledger into one canonical
accounting file, preserving every historical entry losslessly. The API process
is its only writer. Worker and evaluation CLI register runs, reserve attempts,
transition to dispatching and reconcile usage only through bounded internal API
admission operations. The CLI uses dedicated evaluation admission auth with no
case/review authority and has no direct file access or JSON fallback. The worker
keeps its existing run/job scope and must not gain case-table access.

PostgreSQL holds no authoritative spend. It continues to own case truth, jobs
and checkpoints; restored database rows cannot grant a paid attempt or override
ledger state. Accounting and case mutations need no shared transaction: a
persisted reservation without a corresponding case update remains held, while
a queued job without a ledger dispatch grant cannot call the provider.

Configure the canonical location explicitly, for example with
`PA_ACCOUNTING_LEDGER_FILE`. Absent configuration refuses live mode. Keep the
file outside PostgreSQL, app volumes, tracked repository files and every
database restore/reset path. Use a host-persisted location outside the checkout,
mounted explicitly by fixed project account identity rather than Compose
project name. Do not commit its private host path. It must survive `down -v`,
fresh app volumes and a fresh clone. An alternate deployment or API process
cannot create a second ledger for the same project. This is durable accounting,
not tracing, a tmpfs or a credential store.

| Proposed record | Required contents and constraints |
| --- | --- |
| Project account | Fixed identity, migration source digest, schema/policy version, immutable maximum caps, last admitted UTC time, writer/boot generation and live-enabled/recovery state. Never auto-create on live startup |
| Budget run | Server-issued run ID, caller kind (`packaged` or `evaluation`), cap at most USD 10, source/build/prompt/tools/provider versions, case binding or synthetic suite digest, parent recovery relationship, created UTC time |
| Attempt | Unique attempt ID and `(runId, turn, ordinal)`, request hash, model and price snapshot, reserved amount, server UTC day, dispatch owner/fence, state, usage, actual cost and sanitized provider request/message IDs when available |
| Accounting history | Migration manifest and retained reserve/dispatch/reconcile/unknown transitions with unique IDs and increasing revision. Derived totals are checked against complete entries, not trusted independently |

Store monetary amounts as exact integer USD units of 0.0000001 or a stricter
exact decimal. Preserve imported raw numbers alongside canonical values and
normalize only demonstrated serialization residue; round reservation ceilings
upward. Reject duplicate IDs, invalid statuses, negative/non-finite values,
incomplete reconciliations and unexplained aggregate differences. No runtime
delete, cap increase or spend-decreasing edit is permitted. Reconciliation may
replace a reservation with actual usage, with both preserved in history.

### Single writer and durable replacement

Before opening live admission, the API must acquire exclusive ownership using
one fixed project-account lock file on the canonical host mount, independent
of the selectable ledger filename. Create it exclusively, bind it to the
account, canonical ledger real path, host/process and boot identity, and flush
the ownership record and parent directory. Resolve path aliases before checking
identity; alternate ledger configuration cannot select a different lock or
account. The lock is separate from the ledger file replaced on each write.
Hold it for the writer's lifetime, serialize every admission mutation with an
in-process mutex, and verify the owner generation before mutation. A second API
process fails closed. Supported deployment is one canonical host/filesystem;
do not assume a network filesystem provides equivalent exclusive-create,
rename or flush guarantees.

Never remove a lock merely because its timestamp or TTL expired. Transfer or
recovery requires maintenance ownership, proof that the predecessor API writer
and any old dispatch owner have stopped, validation of the latest ledger and
a fresh owner/boot generation. Revoke old grants before reopening admission.
If predecessor absence or lock identity cannot be established, live stays
blocked. A successor cannot make an old worker's reservation dispatchable again.

For each mutation, validate the current complete file under the mutex and writer
ownership, compute the next full ledger, write a restricted temporary file in
the same directory, fsync that file, atomically rename it over the canonical
file, then fsync the parent directory. Return success only after all steps
confirm durability. A failed or ambiguous write stops live admission. Never
fall back to an empty file, an unvalidated temporary file or an older copy.
Recovery validates the canonical replacement before serving calls; a surviving
temporary file alone is not a dispatch grant. Filesystem/storage durability
must be tested on the selected host rather than inferred from rename alone.

### Admission and dispatch protocol

1. Register the run under fixed project policy. Refuse absent, zero, negative,
   non-finite or over-maximum caps. Freeze its cap for all turns and explicit
   attempts; a new job or process cannot supply a higher value. Check mode,
   current source binding, provider configuration and key-file availability
   before creating an attempt. A local preflight failure makes no network call.
2. Under the API's in-process mutex and singleton writer ownership, reread all
   committed actuals plus open and unknown reservations from the canonical
   ledger. Invalid state or uncertain recency disables admission. Use API-host
   UTC time, never caller-supplied dates, and persist the last admitted time so
   a backward clock blocks admission. Reserve only when run, UTC-day and lifetime
   amounts including this reservation fit their caps.
3. Persist each accounting mutation using the durable replacement protocol
   above. A partial temporary write, failed fsync, failed rename or uncertain
   replacement stops admission until reconciliation. No model request may be
   sent on an unacknowledged reservation or dispatch transition. Case/queue
   persistence cannot substitute for the canonical ledger's durable result.
4. Return the existing attempt for identical registration retries; reject the
   same ID with a changed hash. Before any SDK request, transition that attempt
   once to `dispatching`, using the same durable replacement and an exclusive
   process/boot fence. Only the successful transition grants dispatch. A lost
   grant response is unknown, not permission to ask again and resend. Enforce
   one active live dispatch project-wide initially, shared by CLI and worker;
   queued/offline work can still run concurrently. Never release the active slot
   by TTL alone: recovery must prove the old dispatch owner has stopped before
   another owner can send. Its unknown billing hold remains committed.
5. Call the fixed Anthropic endpoint once, with `maxRetries: 0` at client and
   request boundaries, no SDK middleware retry, tool runner, fallback, batch,
   fast mode, server tools or alternate inference geography. No HTTP retry
   layer may wrap Messages creation. A new intentional provider attempt requires
   a new ordinal and reservation. A duplicate application request is not assumed
   to be a free or idempotent provider call.
6. Persist validated complete token usage and response identity before any
   tool execution. Reconcile all billed input, output and cache classes at the
   frozen tariff, including refusals/truncation. Repeated identical reconciliation
   is idempotent; conflicting usage stops admission. Missing/invalid usage,
   timeout, lost response or a crash retains the full reservation as unknown.
   An actual above its ceiling is retained in full and disables further calls
   as a budget-integrity incident, never clipped to fit a cap.

An attempt crossing UTC midnight must remain covered on both affected days:
retain its reservation against each UTC day in which it may be in flight, until
known usage can be attributed conservatively. Admission on the new day first
carries these liabilities forward; an unknown attempt does not age out at
midnight. Run and lifetime totals count it once. The original reservation day
and all carry-forward records remain auditable. Server clock regression also
blocks live admission pending reconciliation.

### Conservative reservation for the first packaged proof

The existing `maxCallCostUsd` uses serialized request bytes as tokens. That is a
heuristic, not an Anthropic billing guarantee; the API also adds tool prompt
overhead. Do not promote it unchanged to the shared budget boundary.

For the first proof, reserve the entire documented 1,000,000-token context at
the highest permitted input tariff, plus all 8,192 output tokens. At USD 5 per
million for 5-minute cache writes and USD 20 for output, this is
`(1,000,000 * 5 + 8,192 * 20) / 1,000,000 = USD 5.16384` per attempt.
This deliberately overcounts a context that also contains output, includes
thinking in the output cap and assumes no cache discount. Only text/client-tool
requests with the frozen standard global tariff and 5-minute caching are
allowed. One-hour cache writes and all surcharged features are refused.

An explicit USD 6 run cap is the bounded first-proof cap, below the USD 10
maximum. Each known low-cost result releases unused reservation capacity for
the next turn. One lost response holds USD 5.16384 and prevents another such
attempt in that run. A reduced ceiling based on a validated request-specific
token bound is future optimization requiring review; token counting is documented
as an estimate and is not by itself a hard bound. If the provider's effective
window, tariff or billing classes cannot be bounded this way, live stays blocked.

### Crash windows and restoration

| Interruption point | Required outcome |
| --- | --- |
| Before any durable reservation | No SDK request; no liability created |
| Temporary ledger write or fsync fails before rename | No successful mutation acknowledgement or dispatch grant. Stop admission; validate the canonical file under maintenance ownership before recovery |
| Rename completed, parent fsync or acknowledgement lost | Replacement outcome is uncertain. Stop admission and preserve any persisted reservation/dispatch liability; never resend because the caller lacks an acknowledgement |
| Reserved, before dispatch transition | No automatic resend or expiry refund after process loss; preserve reservation until a fenced reconciliation proves it was never dispatched |
| Dispatch transition durable, before send or before response persistence | Unknown billing and full hold. Never infer no charge from missing response or terminated process |
| Usage known, graph checkpoint/status report lost | Keep actual spend and proposals. Stop investigation; do not issue a replacement call |
| Review interrupt persisted, status acknowledgement lost | Reconcile checkpoint/API run state under ownership, without model construction or a second call |
| Second API starts or predecessor identity is uncertain | No second writer or dispatch grant; retain exclusive ownership and block takeover until predecessor fencing is proved |
| Old database or checkpoint restored | Canonical ledger is unchanged. Reject fresh registration/repeated dispatch for already recorded run/attempt identities; retain all newer actuals and unknown holds |

The ledger retains complete attempt history, not just a spend total: unknown
reservations, UTC days, run caps, writer generations and IDs matter. On database
restore, start with live disabled, fence the old worker and verify canonical
ledger identity, integrity and recency before reopening admission. Restored
run/attempt identities cannot become fresh budget runs or receive another
dispatch grant. A genuinely new turn still needs a current process-owned run
and a new reservation. Interrupted runs remain stopped as specified below.
Update backup/restore/reset procedures so database operations never
copy, replace, truncate, initialize or delete the canonical ledger or its lock.
Independent retained ledger backups are for controlled reconciliation, never
automatic database restore. No accounting replay from PostgreSQL is needed.

Residual operational risks are ledger loss, storage failure and replacement by
a syntactically valid older copy. Schema validation and singleton ownership
alone cannot prove that a valid file is the latest one. If the ledger is missing,
corrupt, inaccessible, unexpectedly replaced, or its recency is uncertain after
recovery or moving hosts, live calls stay blocked until reconciliation against
retained accounting and available provider usage evidence. An older copy never
becomes a fresh budget, and this note's total cannot bootstrap lost accounting.
No design protects against coordinated rollback of all copies. Keeping the
canonical file outside database restore/reset paths prevents an ordinary older
database restore from rolling spend back; it does not remove these storage risks.

### Migration from the JSON ledger

Quiesce every old CLI/worker writer and retain the original file byte-for-byte
as a separate retained copy. Under exclusive maintenance ownership, establish
the explicitly configured canonical location outside app restore/reset paths,
validate the full schema and reconcile the current snapshot again, rather than
importing just the number above. Convert the ledger in place to the evolved
schema using durable replacement. Preserve every
reservation with its original ID, run/day/timestamps/model, ceiling, actual,
usage and status, including all old open/unknown entries if any have appeared.
Do not collapse history into an opening balance or release an old reservation
because its process is gone. Keep raw values and record the source digest and
a lossless migration manifest in the evolved ledger. PostgreSQL receives no
authoritative accounting copy.

Migration must be idempotent by source digest and reservation ID; changed content
under an existing ID is a conflict. Prove per-entry equality, counts, per-run/day
and lifetime totals before enabling the account. At this snapshot the manifest
must show 133 reconciled entries and USD 1.9394876 committed. This explicit
maintenance conversion is the only schema-initialization path; normal live
startup never initializes missing accounting. Retire the old CLI file admission
route after conversion and verification, before enabling either new caller. If any
old writer can still spend independently, live activation stays blocked.

## Decision: safe stopping after interruption

The graph checkpoint contains observations, counters, pending tool input, trace,
proposals and versions. The live provider separately holds `messages`, complete
assistant blocks, `pendingToolUseId` and `consumed` in memory. A fresh provider
cannot derive the exact SDK conversation from graph observations and can either
hit `LiveTranscriptMismatch` or repeat work before enough observations exist
to reveal a mismatch. PostgreSQL graph durability alone does not solve this.

Choose safe stopping. A live investigation is owned by one process
generation. Once interrupted before its durable human-review boundary, fence
its attempt/run, retain accounting, prohibit further tools/review on incomplete
work, and expose an operator-action-required failure. Do this before invoking
the graph on a compatible checkpoint; do not rely on the transcript exception.
Recovery creates an explicit new investigation bound to reread case, sources,
policy and packet, with a new attempt and charged allowance. Retain the old
run, proposals and failure history. A waiting checkpoint with the matching
versions can resume `review -> finalize` without a provider or key; no model
turn is permitted in this recovery. An incompatible or incomplete checkpoint
stops safely instead. Repeated status/review/completion delivery stays idempotent.

Exact conversation reconstruction is deferred. It would require durable complete
ordered assistant blocks/signatures and matching tool-use/result IDs, immutable
system/tools/model prefixes, request hashes and attempt outcomes, plus recovery
at every call/checkpoint boundary. Do not synthesize thinking blocks, drop them
to guess history or regenerate a missing paid response. No transcript bodies or
model reasoning belong in logs or committed evaluation reports.

## Proposed configuration and secret distribution

The current [agent config](../../packages/agents/src/config.ts),
[core config](../../packages/config/src/index.ts), [.env.example](../../.env.example),
[Compose](../../compose.yaml), [launcher](../../docker/rootfs/usr/local/lib/pa/launch.mjs)
and [Dockerfile](../../Dockerfile) must change together. These were
the proposed names and behavior at the inspected revision; the
[implementation record](#implementation-record) lists the implemented names.

| Setting or recipient | Proposed contract |
| --- | --- |
| `AGENT_GRAPH_PROVIDER` | `off` remains default; `recorded` remains explicitly selectable; add explicit `live`, mapped to persisted provider `anthropic`. No implied switch from key presence |
| `DATA_MODE`, `AUTH_MODE`, `AGENT_MODE` | Keep fixture, fixture and rules respectively. Live assistance does not replace deterministic assessment or permit real records |
| Run/daily/total budgets | Preserve zero defaults; add explicit total cap configuration. Live requires positive caps no greater than USD 10/20/20, further limited by immutable shared policy and remaining allowance |
| Provider model/effort/output | Frozen `claude-opus-5-5`, medium, 8,192, standard global pricing; record requested and returned model identity. No automatic upgrade or fallback |
| `PA_ACCOUNTING_LEDGER_FILE` | Explicit API-only canonical host-file location; no default or private path in tracked configuration. Absent configuration refuses live mode |
| Worker only | Read provider key through `PA_ANTHROPIC_API_KEY_FILE`, mounted read-only in an optional live Compose configuration. No key value in env, image, browser bundle, logs or Git |
| API only | Canonical accounting file and stable ownership lock mount, admission policy and singleton writer generation; no provider key variable. Worker uses existing run/job service scope; CLI gets separate narrowly scoped evaluation admission auth |
| CLI | Explicit live command/key file/run cap plus canonical admission identity. Fail if admission service is unavailable; no independent JSON fallback |
| Off and recorded | Require neither provider key nor accounting mount/service. Do not read the key or construct an SDK client. Remain usable if live preflight fails |

Do not make a missing optional live secret prevent the default Compose demo from
starting. Explicit live selection with a missing/empty/unreadable key, unavailable
provider, invalid caps or unavailable accounting must report unavailable/refused,
with no silent fallback. Missing key causes zero SDK requests; a remote access
failure after dispatch retains its reservation unless complete usage is known.
Capability reports contain availability and redacted limits, never key contents
or sensitive paths. Recheck admission at the attempt boundary even if startup
preflight passed. Secret-file readability is not account-access verification.

The [credential matrix](../operations.md#credential-matrix) is process environment
hygiene: all app processes share uid 10001 and a container filesystem. A key
mounted for the worker is physically readable by that uid, including a compromised
web process. Do not claim process isolation. Preserve no admin/migrator credential
in the app, no external tracing and synthetic-only tools. Evaluator expectations
remain excluded from the packaged image.

## Official Anthropic refresh

Primary sources accessed 2026-10-22. These public documents are not account
access, credential checks or a new model evaluation.

| Source | Verified documentation fact and design consequence |
| --- | --- |
| [Models overview](https://platform.claude.com/docs/en/models/overview) and [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview) | Lists active `claude-opus-5-5` on Claude API, with a 1M context, 128K maximum output and medium default effort. Retain this existing model for continuity; cap local output much lower |
| [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | Standard USD/MTok: input 4, output 20, 5-minute cache write 5, 1-hour write 8, cache hit 0.20. Client tools consume tokens; Opus 5.5 auto tool prompt adds 286 tokens. Only the selected standard tariff and 5-minute caching are admitted |
| [Opus 5.5 changes](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5) | Thinking is always on; omission selects adaptive thinking. Forced `any`/`tool` choice is unsupported. Return thinking blocks unchanged; prefix binding can reject changed earlier system/tools/history. Use append-only conversation during a single process, with explicit medium effort |
| [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) | Client executes `tool_use`, then supplies immediately following user `tool_result` with matching ID and `is_error` for failure. Preserve complete assistant content, not just the selected tool's arguments |
| [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) and [strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) | `auto` with `disable_parallel_tool_use: true` permits at most one tool, including none. `strict: true` constrains schema, not source truth or authority. Reject unexpected multiple-tool shapes locally; continue API validation |
| [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript#retries) | Errors and timeouts can retry twice by default. Explicitly disable SDK and per-request retries. Keep direct Messages calls, not an automatic tool loop |
| [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) and [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) | Context includes tools and cached input; thinking is within `max_tokens` and billed as output. Token counting is free but estimates usage and is not used for the first proof's reservation ceiling |

Recheck prices/model lifecycle immediately before paid verification. Refusal,
truncation and unexpected stop reasons are potentially billed outcomes to reconcile and
stopped outputs to validate; they do not justify free retries. Current account
access, effective limits, actual cache behavior and packaged secret readability
remain unvalidated here.

## Verification design

These are design expectations, not passed tests. Before implementation tuning,
an independent evaluator/reviewer must freeze fixture hashes, failure injection
points and expected ledger/API/UI outcomes in evaluator-owned material excluded
from runtime. Implementer-written fakes may drive transport; they cannot
determine
their own gold outcomes. Check the exact final implementation revision, then
record source/image hashes, commands, outcomes and remaining limits separately.

### Offline fake-provider checks

| Scenario | Required evaluator-owned observation |
| --- | --- |
| CLI/worker concurrency near each cap | Competing callers use one API writer and its mutex; only fitting reservations succeed. Project-wide single-dispatch limit holds. Every fake network attempt has exactly one durable grant; denied attempts make zero requests |
| Lost reservation or dispatch acknowledgement | Identical registration returns the same ID without another charge; uncertain dispatch never grants a second send. Changed hash under the same ID is rejected |
| Lost provider response, timeout, crash and late response | Full reservation survives restart; unknown billing is visible and no automatic model retry occurs. Late usage can reconcile the same attempt idempotently, but cannot revive cancelled/stale authority |
| Every ledger write crash window | Inject failure during temporary write, file fsync, rename, parent-directory fsync and acknowledgement. No unconfirmed mutation grants dispatch; recovery validates the canonical file and keeps persisted/unknown liabilities. Temporary files do not authorize calls |
| Second API writer and predecessor fencing | Exclusive ownership refuses a second process. A stale lock or expired TTL cannot authorize takeover; prove the old writer/dispatch owner stopped before assigning a new boot generation. Old generations cannot write or dispatch |
| Stale source/policy/packet and cancellation | Actual API rejects stale read/proposal/apply; changed inputs cannot retain readiness or accepted candidate authority. No cross-case read, source editing, clinical drafting or transmission occurs |
| Unavailable provider | Startup refusal creates no request. A fake remote failure after grant makes exactly one request, holds unknown spend and exposes failure, with no recorded fallback |
| Missing/empty/unreadable key | Live is refused before network I/O. Off/recorded start without reading key or requiring live accounting |
| Zero/absent/invalid caps; missing/corrupt ledger | Zero SDK requests, explicit refusal. No empty-account initialization. Test all three caps independently, including attempted cap increases |
| Midnight and clock regression | Outstanding liabilities carry into the new UTC day, lifetime is counted once, day rollover never releases unknown usage, backward clock stops admission |
| Restart during investigation | Safe stopped state before graph reinvocation, no reconstructed or repeated call, retained proposals/spend and explicit fresh-run recovery |
| Restart at human review | Compatible checkpoint and persisted review event resume finalize with zero SDK construction/requests. Stale/incompatible input stops; local request and packet approval remain separate |
| Older database backup and fresh-volume restore | Create newer fake spend/unknown entries after database backup; restore app DB/checkpoint and prove canonical ledger bytes/totals unchanged. Restored run/attempt identities cannot get another dispatch grant; no per-run/day/lifetime liability is lost |
| Ledger loss, uncertain recency or alternate project/CLI ledger | Missing/corrupt state, storage failure, suspected valid older replacement or uncertain recency blocks live until reconciliation. Neither an alternate path nor missing configuration creates a fresh account. Default offline demo still works |
| JSON migration | Every old reservation survives with original IDs/status/usage and raw values. Import replay is idempotent; conflicting duplicate or missing history blocks activation |
| Usage, bounds and tool semantics | No hidden SDK/fallback requests; actuals are exact and not clipped. Invalid/missing usage holds reservation. Refusal/truncation/multiple or unsupported tools execute no tool; ordinary valid proposals still traverse the API gate |

Run these against the real admission implementation with fake network responses
and disposable database/ledger resources, including packaged startup and restore.
They are not paid-model checks and must not use a retained deployment database,
volumes, ledger or key. General application and container checks run as part of
the normal [development checks](../development.md#checks).

### Packaged paid proof requirements

After offline checks, independent review and accounting migration pass, run one
packaged operator investigation on the existing missing-order synthetic demo
case, through UI, BFF, queue, worker, Claude and actual API proposal gate. Use
medium effort, 8,192 output cap, at most six turns/ten tools/180 seconds, one
live dispatch at a time and a USD 6 run cap. Reserve USD 5.16384 before each
attempt; honor lower current lifetime/day headroom and stop if it cannot fit.
This is a cap on liability, not a target spend. Do not rerun the 22-case paid
suite or spend on failure injection for this packaged-path proof.

Freeze the exact demo case/assessment/source/policy/packet hashes and evaluator's
required supported facts or applicable neutral missing-document request before
the call. Successful proof requires at least one useful, source-linked candidate
through the real gate, an explicit human accept/reject decision and current-input
finalization. A tool-only conversation or empty proposal set is partial evidence;
report it without tuning the oracle or making an automatic paid retry. Failure
recovery and stale binding can be demonstrated with the fake provider. Restart
the real run while it waits for human review, then complete review with zero
additional model calls. Do not kill a paid request deliberately.

Record actual model/request identity, run/job/attempt/proposal/review correlation,
hashes, latency, usage, actual and held cost, before/after shared totals and exact
source/image revision without key, bodies or reasoning. Verify no request was
auto-approved, no order/medical note was generated, and no payer action occurred.
Stop on provider/account failure, unknown billing, accounting mismatch or cap
refusal; report partial evidence. A comparative contribution evaluation
needs separately frozen contribution expectations and its own bounded run plan
within the same remaining lifetime budget. Packaged success alone establishes
neither incremental benefit nor clinical/payer/production validity.

## Operational assumptions

The ledger's filesystem durability, singleton writer/predecessor fencing,
mount/reset exclusion and storage recovery are design requirements that must
hold on the selected deployment host, with independent implementation review
before activation. Ledger recency after storage recovery remains an
operational responsibility; a valid older file cannot be detected from its
schema alone.

The paid proof assumes the synthetic demo provides an applicable missing-order
finding and the account serves the documented model. The evaluator pins the
former; an authorized runtime establishes the latter. Record the canonical
ledger location and retained-copy custody without committing private host
paths. Without migrated accounting, packaged live stays off.
