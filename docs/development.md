# Local development

This guide covers source development for the TypeScript application: Next.js web,
Fastify API, durable worker and PostgreSQL. Use [the packaged quickstart](../README.md#quickstart)
for the shortest no-key demo, [operations](operations.md) for containers and
[architecture](../ARCHITECTURE.md) for the component and trust boundaries.

## Toolchain and install

Use **Node 24.22.0** and **pnpm 12.14.0**. The root
[manifest](../package.json) declares the package manager and Node range
`>=24.22.0 <25`; [pnpm configuration](../pnpm-workspace.yaml) enforces the engine
range and records exact dependency pins. The lockfile was produced by pnpm 12.14.0.

```sh
pnpm --version
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
```

Typecheck comes before lint on a fresh clone because `@pa/web` runs `next typegen`
to create the route types. There is no root `dev` or formatting script. Use the
implemented commands below rather than assuming framework defaults.

Dependency lifecycle scripts are reviewed through `allowBuilds`; esbuild's
postinstall remains disabled. Do not disable engine or peer checks to accommodate
an unreviewed update. The pinned stack is listed in
[ARCHITECTURE.md](../ARCHITECTURE.md#runtime-and-package-map). The source catalog
and lockfile are authoritative for installed versions, not a claim of latest releases.

## Repository layout and import boundaries

| Location | Responsibility |
| --- | --- |
| `apps/web` | Server-rendered case queue, sources, requests and packets; authenticated BFF |
| `apps/api` | Sessions, case scope, deterministic assessment authority, workflow and agent proposals |
| `apps/worker` | Durable assessments, simulated requests and recorded graph investigations |
| `packages/contracts` | Versioned Zod domain, workflow and agent contracts |
| `packages/domain` | Pure administrative rules and v2 assessment |
| `packages/db` | Drizzle schema/migrations, roles, repositories, pg-boss and checkpoints |
| `packages/config` | Validated service settings and secret-free topology export |
| `packages/agents` | Bounded graph, tools, recorded provider and evaluation-only live provider |
| `packages/connectors` | Fixed synthetic fixture registry and archived responses |
| `evals` | Independent fixtures, frozen oracles, scoring, holdouts and reports, excluded from runtime |
| `policy-packs` | Reviewed lab rules and provenance |
| `scripts` | Demo, backup/restore, favicon source and container checks |

Packages export a custom `@pa/source` condition. Typecheck and Vitest resolve it
to TypeScript sources; builds and runtime resolve to `dist/`. See
[the policy-slice guide](policy-slice.md) for contracts, fixtures and oracles.

[ESLint](../eslint.config.js) enforces these boundaries:

- Web application code cannot import database, API, worker or provider modules,
  whether through package names or relative paths. It may import only the
  secret-free `@pa/config/topology` configuration entry.
- Runtime apps/packages cannot import evaluator code or oracles. Independent
  expected outcomes never enter the application image.
- `packages/domain` imports only its own files and `@pa/contracts`, with `vitest`
  additionally available to tests. It has no I/O, provider, database or process
  authority. Time, locale and randomness must not influence its results.

The API owns business decisions. The worker obtains case content through scoped
internal routes and reports results for API revalidation. UI code presents those
results rather than recomputing authority in the browser. Use Server Components
by default and consult the installed-version Next.js docs before framework changes.

## Configuration

[.env.example](../.env.example) and [the configuration reference](operations.md#configuration-reference)
list implemented settings. Compose loads `.env` for interpolation. API/worker entries, test helpers and shell scripts read exported variables;
they do not load the root `.env`. Do not bulk-source it into every process. Credentials are per role.

The supported runtime is `DATA_MODE=fixture`, `AUTH_MODE=fixture`,
`AGENT_MODE=rules`, with `AGENT_GRAPH_PROVIDER=off` or `recorded`. Unsupported
modes fail startup. Inline credentials and their `_FILE` variants are mutually
exclusive; prefer ignored local files. Runtime API/worker environments must not
receive admin or migrator credentials, and web must not receive database or
provider credentials. [Operations](operations.md#credential-matrix) explains
what this separation does and does not isolate.

## Test database

Integration and built-web checks use disposable PostgreSQL at
`127.0.0.1:35105`, Compose project `prior-authorization-test`. Stop host-process
API/worker instances using that server first: test provisioning resets cluster-wide
role passwords. The harness rejects detected non-test runtime sessions, but an
idle API may have no open connection.

```sh
export PA_TEST_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
pnpm db:test:up
```

Keep the same password in the shell running the tests. A value in `.env` alone
configures Compose but does not reach Vitest. For another disposable server,
export `PA_TEST_ADMIN_DATABASE_URL`; this takes precedence over the generated
password URL. Never point it at a retained deployment.

Each test file creates a unique database, provisions roles and applies the real
migrations, then drops its database. Connection URLs are redacted in test output.
After checks:

```sh
pnpm db:test:down
```

This removes the test database volume. PostgreSQL applies a bootstrap password
only when the volume is first initialized. If it contains an older password,
remove only this disposable test deployment and start it again with the current
password. Do not change credentials against retained application volumes.

## Checks

Run the database-free checks after installation, in this order:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:evals
pnpm test:oracles:v2
```

With the disposable test database running:

```sh
pnpm test:integration
pnpm build
pnpm test:web
```

| Command | What it checks |
| --- | --- |
| `pnpm typecheck` | Root/scripts and every package/app; web generates route types |
| `pnpm lint` | Type-aware ESLint with zero warnings and enforced import boundaries |
| `pnpm test` | Unit tests, build-free web tests, graph/provider fakes, accounting ledger and migration, SDK call-site guard, domain rules, fixture/oracle validation and harness tests |
| `pnpm test:evals` | Frozen rules assessment and separately labelled scripted graph comparisons; no provider call |
| `pnpm test:oracles:v2` | Registered v2 fixtures, structural oracle checks and recipe pins; no assessment |
| `pnpm test:contribution` | Only the agent contribution evaluator: package hashes, scorer, evaluator-only fakes and the frozen rules-only baseline; no provider call (also part of `pnpm test` and `pnpm test:evals`) |
| `pnpm test:integration` | Actual disposable PostgreSQL, roles, queues, sessions, cases, workflows, recorded investigations and packaged live mode with a fake Messages client |
| `pnpm build` | Compiled packages/services and Next standalone output |
| `pnpm test:web` | Built web server with in-process API and test database, driven over HTTP |
| `pnpm test:container` | Docker image, supervision, health, persistence, failure and secret-canary checks |
| `scripts/demo/smoke.sh` | Packaged offline workflow, restart, backup and fresh-volume restore |
| `pnpm test:evals:live` | Separate explicit paid Claude evaluation; see the requirements below |

The web project selects `*.build.test.ts`; other web tests run in the unit
project. Built-web boundary checks bind API port 4105, so stop a host API first.
HTTP assertions do not prove real-browser interaction or accessibility.

Frozen evaluation compares findings, conditions, citations and document versions,
with complete-set mismatches failing the command. False-ready reports include
numerators and denominators; expected input rejection is reported separately.
Deferred expectations do not count as passes. Keep fixture/oracle pins and
expected results independent of implementation changes.

Record exact source revision, command, exit result and limitations for any new
verification. Existing reports are historical evidence, not a pass for a later
revision. For documentation-only edits, check links, command references,
formatting and preserved bytes without calling that application verification.

## Container tests

```sh
pnpm test:container
pnpm test:container -t 'container 6\.'
```

The driver in [scripts/container](../scripts/container) builds a temporary copy of
the checkout, generates throwaway secrets and runs `prior-authorization-ctest` on
loopback port **36105**. It does not read the deployment's `.env` or `.secrets`.
It copies tracked and non-ignored untracked files, so preserve and inspect the
checkout before choosing it as verification input. The suite removes its own
containers, volumes, test images and temporary copy. Run only when that test
project/port is free.

The 14 groups cover fresh initialization, process death, invalid configuration,
heartbeat staleness, database outage, shutdown/drain, persistence, privileges,
secret scanning, blocked queries, startup timeout, image contents, the optional
live overlay (ledger migration in the image, per-process paths, lock transfer on
a graceful restart, missing ledger) and logs. Group 14 uses a fake key and never
starts a live run. A
full run is required to make the final log scan cover all groups. The
[operations evidence](operations.md#recorded-verification) records historical tested
revisions and gaps; a focused group does not substitute for the full matrix.

Use [the demo smoke](demo.md#scripted-smoke) for the case/request/review loop and
fresh-volume restore. It needs Node 24.22.0 as well as Docker and standard POSIX
utilities, including curl, netcat (`nc`), `od`, `tar` and `shasum`. It drives HTTP,
not a browser. Reviewed screenshots and browser accessibility evidence remain
separate checks.

## Host-process run

This advanced path runs built services against PostgreSQL, without s6 supervision.
Use the packaged demo for automatic provisioning and coordinated startup.
For host development, build first (`pnpm build`) and use a database server that
no test is changing. The disposable test server can be used only after stopping
all tests. Prepare ignored credential files with connection URLs for that server
(loopback **35105** for the default test server, not Compose's internal `db:5432`).
Keep the four role passwords consistent across provisioning and runtime.

Set common, non-secret configuration in each shell:

```sh
export APP_ID=prior-authorization
export DATA_MODE=fixture AUTH_MODE=fixture AGENT_MODE=rules
export PA_PUBLIC_ORIGIN=http://127.0.0.1:3105
```

The following `_FILE=...` values are placeholders for your absolute local file
paths. Provision with all four role URL files, migrate with only the migrator
URL, and start API and worker in separate shells with their own credentials:

```sh
DATABASE_URL_ADMIN_FILE=... DATABASE_URL_MIGRATOR_FILE=... DATABASE_URL_API_FILE=... DATABASE_URL_WORKER_FILE=... \
  pnpm --filter @pa/db provision
DATABASE_URL_MIGRATOR_FILE=... pnpm --filter @pa/db migrate
DATABASE_URL_API_FILE=... WORKER_SERVICE_TOKEN_FILE=... BETTER_AUTH_SECRET_FILE=... \
  node apps/api/dist/main.js
DATABASE_URL_WORKER_FILE=... WORKER_SERVICE_TOKEN_FILE=... \
  node apps/worker/dist/main.js
```

Start web in a third shell after the API is listening:

```sh
pnpm --filter @pa/web start
```

The committed `start` script binds loopback port **3105**. Next warns about
`next start` with standalone output; this path previously served HTTP, while
the container uses the standalone `server.js` entry. This is not a hot-reload
command. The API seeds the synthetic queue and fixture identities. Open `/` for
the workbench or `/pilot` for the synthetic transport probe. Stop each host
process with SIGTERM before database teardown or test provisioning.

Schema changes are generated with `pnpm --filter @pa/db generate`; review the
SQL and migration metadata before committing. The migrator owns DDL and pg-boss
queue creation; runtime roles must not gain migration privileges. The SQL grants
and [schema](../packages/db/src/schema.ts) define current domain/auth access.

## Live Claude evaluation

Packaged live mode and this command share one admission service
([ADR 0001](adr/0001-packaged-live-agent.md),
[operations](operations.md#live-accounting)). The separate `pnpm test:evals:live`
command makes paid Messages API calls over synthetic cases, using an evaluator
tool port that mirrors API checks rather than invoking the packaged API's case
routes. It holds no ledger: it registers a capped run with a running live-mode
API through the evaluation admission routes, and every attempt is reserved and
granted there before it is sent. It is never part of the offline checks.

Because the packaged API listens on loopback inside its container, the command
needs a host API (`pnpm build`, then the API started as in
[host-process run](#host-process-run) with `AGENT_GRAPH_PROVIDER=live`, its caps,
`PA_ACCOUNTING_LEDGER_FILE` and `PA_EVALUATION_ADMISSION_TOKEN_FILE`).

Export evaluation settings only for an explicitly authorized run:

| Variable | Requirement |
| --- | --- |
| `PA_ANTHROPIC_API_KEY_FILE` | Required absolute key-file path; key value never in the environment |
| `PA_ADMISSION_API_ORIGIN` | Required exact loopback origin of the live-mode API, for example `http://127.0.0.1:4105` |
| `PA_EVALUATION_ADMISSION_TOKEN_FILE` | Required file holding the API's evaluation admission token (32+ characters) |
| `PA_LIVE_RUN_CAP_USD` | Required positive cap at most USD 10, further limited by the API's day and lifetime caps |
| `PA_ANTHROPIC_LEDGER_FILE` | Retired and refused; accounting belongs to the API |
| `PA_LIVE_EFFORT` | `low`, `medium` (default) or `high` |
| `PA_LIVE_CASES` | Optional comma-separated subset; unset selects the registered 22 cases |
| `PA_LIVE_RUN_LABEL` | Optional report label, 1-40 lowercase letters/digits/hyphens; unset defaults to `full`, empty is invalid |
| `PA_LIVE_PROMPT_NOTE` | Optional factual report note; never secrets, model text or reasoning |

The provider uses the pinned `claude-opus-5-5` configuration, medium effort and
8,192 maximum output tokens by default. Its endpoint and tool definitions are
explicit; SDK retries and external tracing are disabled. Recheck primary provider
sources for model availability and prices before any paid verification.

Project caps are **USD 10/run**, **USD 20/UTC day**, **USD 20 lifetime**.
Recorded spend is **USD 1.9394876**, leaving at most **USD 18.0605124**, subject
to reconciliation with all later calls and unknown reservations. A new run or
milestone does not reset spending. Nothing creates a ledger from nothing: the
canonical ledger comes only from migrating the retained v1 file. Missing,
corrupt or uncertain accounting blocks live calls while offline work continues.

Each attempt reserves the full worst case for the pinned tariff and output
limit (USD 5.16384 at 8,192 tokens). A USD 10 run cap admits one such attempt
at a time, with capacity for a successor after reconciliation. Reported usage
reconciles exactly; unknown usage stays held in full.

Offline checks exercise the accounting and provider code in
`apps/api/src/accounting` and `packages/agents/src/providers`, the worker in
`apps/worker/test/agent-live.integration.test.ts`, and container group 14, all
with fake provider responses and disposable resources. Their scope:

- a worker or API interruption with a provider request in flight is simulated
  in the integration tests
- concurrency near each cap is checked against the ledger directly, with one
  cross-caller dispatch check over HTTP
- built-web checks run the investigation panel in recorded mode
- the smoke exercises restart and restore of the offline deployment

The [live evaluation report](../evals/reports/live-claude/2026-10-21-full.md)
records actual-provider behavior through the evaluator port.

Refusal, truncation, unexpected output, provider error or budget refusal stops
the affected run and is reported; a failed live run cannot pass. Do not rerun
blindly after an interruption or remove a ledger lock without proving the prior
writer has stopped and reconciling accounting as described in
[live accounting](operations.md#live-accounting).

Reports go to `evals/reports/live-claude/<UTC date>-<label>.json` and `.md`, with
source revision, hashes, tool names, outcomes, usage and cost, without source
bodies or model reasoning. [The measured report](../evals/reports/live-claude/2026-10-21-full.md)
records the prior 22-case evaluation and its limits. Its equal issue scores inherit
rules and do not demonstrate incremental model benefit.

## Agent contribution evaluation

The contribution evaluator scores retrieval and request utility separately from
inherited deterministic issue and readiness scores.
Its regression cases, frozen gold and scoring contract are evaluator-owned:

| Path | Contents |
| --- | --- |
| `evals/suites/contribution/fixtures/` | Regression cases CR01 to CR04 in the v2 fixture layout |
| `evals/expectations/contribution/` | Gold, scoring contract, run plan, report template, README and `SHA256SUMS`, copied byte for byte |
| `evals/src/contribution/` | Adapter, scorer, evaluator-only fakes and tests |
| `evals/reports/contribution/` | Recorded baselines and any later comparison reports |

Runtime, prompt and image paths never read these files; independence tests
enforce that. `pnpm test:contribution` verifies package hashes, then runs the
scorer, every fake and the frozen-baseline comparison offline.

Fakes are scripted turns labelled `fake:<name>`. They run through the real graph
on the evaluator port, which mirrors the API proposal gate but is not that gate,
and they are never model evidence. The adapter accepts only a recorded
provider labelled `scripted_fixture`. The
[2026-10-24 baseline](../evals/reports/contribution/2026-10-24-baseline.md)
records rules-only retrieval, requests, safety and the CR01+CR03 comparison
subset's maximum attainable positive delta. Evaluator-only fakes validate scorer
behavior; issue and readiness scores remain inherited from deterministic
assessment.

## Historical verification notes

The following notes record earlier source revisions, observed outcomes and
temporary mutations restored after verification. They are historical engineering
evidence, not instructions to modify the checkout; the setup and commands above
describe the current check surfaces.

### Unit, boundary and assessment experiments

Each failure mode below was observed with a temporary source mutation that made
the named tests fail; every mutation was reverted and the suites rerun green.

| Group | Test file | Mutations observed failing |
| --- | --- | --- |
| 1, 2 | `apps/api/test/enqueue.integration.test.ts` | `send()` without the transaction `db` option (rollback leaves a job; an uncommitted job is consumed) |
| 3 | same | Replay ignoring the request hash (changed payload returns 200, not 409) |
| 4 | `packages/db/test/roles.integration.test.ts` | Worker DML on `pa_app.pilot_probes`; `CREATE` on `pa_app` for the API; PUBLIC `EXECUTE` on pg-boss functions left in place |
| 4 | `packages/db/test/supervision.integration.test.ts` | Worker `EXECUTE` on `job_now()` removed ("permission denied for function job_now"); worker `DELETE` on `job` and `job_common` removed ("permission denied for table job_common") |
| 5 | `packages/db/test/queue-schema.integration.test.ts` | Runtime `migrate: true`; wrapping every startup error as a queue schema error |
| 6 | `packages/config/src/index.test.ts` | `DATA_MODE=live` accepted; inline and `_FILE` conflict check removed; forbidden credentials accepted |
| 7 | `apps/api/test/internal-route.integration.test.ts` | Token check bypassed; probe and job match removed; active-job check weakened |
| 8 | `apps/web/test/web-boundary.build.test.ts` | Rewrite exposing `/internal/*`; buffered upstream body; abort signal and cancellation dropped; body limit removed; notice removed from the layout; status listing exposing keys; page assuming modes when the API is down |
| 8 | `apps/web/test/upstream.test.ts` | A client body read error reported as `upstream_unavailable` (502 instead of 400) |
| 8 | `apps/web/test/web-boundary.build.test.ts` (shuffle seed 3) | API-unreachable case no longer restoring the API (five later tests fail with 502) |
| 8 | `apps/web/test/global-error.test.ts` | Pilot notice removed from the global error page |
| 8 | `apps/web/test/web-boundary.build.test.ts` | `apps/web/app/favicon.ico` removed: the page no longer links `/favicon.ico` |
| Worker | `apps/worker/src/shutdown.test.ts` | Forced exit 4 s after the drain deadline; worker `timeout-down` 33 s; API `timeout-down` 9 s (worst case 56 s); app `stop_grace_period` 59 s |
| Harness | `packages/db/test/test-server.integration.test.ts` | Host-run session guard disabled; test database printed without redaction |
| Worker | `apps/worker/test/flow.integration.test.ts` | Malformed payload failed with retries instead of terminally |

Removing `no-transform` alone did not make group 8 fail: Next did not compress
the streamed SSE response in that run, so the header is kept as a defence for
intermediaries rather than a proven requirement. In group 4,
`create_queue`, `delete_queue` and `job_table_run_async` are refused to runtime
roles even with PUBLIC `EXECUTE`, because their bodies need privileges the roles
lack; the revoke makes `job_table_format` and `job_table_run` unreachable too.
The worker flow test also checks that the heartbeat's `last_job_id` equals the
probe's persisted job ID and that the pg-boss job reaches `completed`.

Lint enforcement was confirmed with temporary violations, which were reverted: a
floating promise (`@typescript-eslint/no-floating-promises`), web imports of
`@pa/db` and the `@pa/config` root (`@typescript-eslint/no-restricted-imports`),
a root `apps/web/proxy.ts` importing `@pa/db` and `../api/src/app`, an
`apps/web/instrumentation.mjs` importing `../../packages/db/src/index.ts`, a
`lib` file re-exporting `../../worker/src/worker` and dynamically importing
`../../api/src/app`, a relative import of `packages/config/src/index`, re-exports
of `../../../packages/config` and `../../../packages/config/src`, a dynamic import
of `../node_modules/@pa/db`, an `apps/web/leak.cjs` calling `require()` on
`@pa/db`, `pg`, `../worker/src/worker` and the config entry, an
`import db = require('@pa/db')` in a `.ts` file (`boundaries/no-server-imports`),
a `.cts` file (parsing error), a conditional hook (`react-hooks/rules-of-hooks`)
and an `<img>` element (`@next/next/no-img-element`). A relative import of
`packages/config/src/topology` stayed allowed.

Evaluator independence: the local rule `boundaries/no-evals-imports`
applies to every TypeScript and JavaScript file under `packages/` and `apps/`. It
rejects imports, re-exports, dynamic imports, `require()` and `import x =
require()` that reach `evals/` by a relative, absolute or `node_modules` path, or
the `@pa/evals` package; `evals/src/independence.test.ts` also fails if any file
there contains the `evals/oracles` path as text, or mentions `evals` together
with an `'oracles'` string literal (a path assembled from segments). Proved with temporary files that
were then removed: a contracts `.ts` file (JSON import of an oracle, `export *`
from `@pa/evals`, a re-export and a dynamic import from `evals/src`), a
`packages/db` `.ts` file (`import x = require()`, also reported by
`@typescript-eslint/no-require-imports`), an `apps/web/lib` `.ts` file (relative
and `../node_modules/@pa/evals` imports), an `apps/api` `.cjs` file (two
`require()` calls) and an `apps/worker` `.mjs` file (an absolute path to an oracle
and a re-export from `@pa/evals`) produced all 11 expected
`boundaries/no-evals-imports` errors, and the path test listed the three files
that contained `evals/oracles`.

Assessment purity: the local rule `boundaries/pure-domain-imports`
applies to every TypeScript and JavaScript file under `packages/domain`. It is an
allowlist: besides relative paths that stay inside `packages/domain`, a file may
import only `@pa/contracts`, and a test file (`*.test.*` or under
`packages/domain/test/`) also `vitest`. It rejects Node built-ins (with or
without `node:`), every other package (database, queue, HTTP, provider,
configuration, app and evaluator modules), relative or absolute paths that leave
the package, computed specifiers in `import()` and `require()`. The same files
may not use the `process`, `Buffer`, `require`, `module`, `__dirname`,
`__filename`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, timer,
`queueMicrotask`, `performance`, `navigator`, `localStorage`, `indexedDB`,
`Date` or `Intl` globals (also through `globalThis`), `Math.random()`, Web
Crypto randomness (`getRandomValues`, `randomUUID`) or the members that read the
environment's time zone or locale (`getTimezoneOffset`, `resolvedOptions`,
`toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`,
`toLocaleUpperCase`, `toLocaleLowerCase`, `localeCompare`). SHA-256 comes from
the Web Crypto global or an injected hasher. The package has no `@types/node`:
both its build and its test program compile with the `es2024` and `DOM` libs and
`types: []`, and neither loads Node types. Proved with temporary files that were then removed: a
`packages/domain/src` `.ts` file importing `node:fs`, `fs/promises`, `crypto`,
`@pa/db`, `pg`, `drizzle-orm`, `@anthropic-ai/sdk`, `@langchain/anthropic`,
`@pa/api`, `@pa/worker`, `@pa/config`, `@pa/evals`, `zod`, `vitest`, an evals
harness file, an oracle JSON file, an API source file, a `packages/db` file and
a contracts source file by relative path, `import x = require('pg-boss')`, a
computed `import()`, `process.env`, `globalThis.process`, `Date.now()`,
`new Date()`, `Date()`, `fetch`, `setTimeout` and `Math.random()`; a `.mjs` file
calling `require()` on `node:fs` and a `packages/db` path; and a test file
importing `node:fs` (its `vitest` import stayed allowed). ESLint reported 38
errors covering every listed import and use, and
`evals/src/independence.test.ts` listed the `.ts` file for its oracle path. A
second temporary `.ts` file in a later fix round used `Date.now()`,
`new Date()`, `new Date('2026-10-18T00:00:00Z')`, `globalThis.Date`,
`Intl.DateTimeFormat().resolvedOptions()`, `globalThis.Intl`, each of the
locale and time zone members above, `crypto.getRandomValues`,
`crypto.randomUUID()` and `globalThis.crypto.randomUUID()`, with `node:fs`,
`@pa/db`, an evals path and `process.env` again; ESLint reported 25 errors, at
least one on each of the 21 violating lines.

### Recorded assessment mutations

Each rule behavior the first slice exercises was observed failing under a
temporary source mutation, run by itself with `pnpm test:evals` (or the domain
unit tests where no frozen fixture exercises it) and then restored byte for
byte, with the SHA-256 of every `packages/domain/src` and `evals/src` file
checked afterwards. The whole table was rerun on that fix round; the
`Fix` rows guard that round's review findings. R10 is deferred to the durable
workflow (S4) and has no mutation.

| Rule | Mutation | Failed |
| --- | --- | --- |
| R01 | A stated LCMP incorporation is a scope conflict | F23 |
| R02 | Binding by metadata alone; the body is never compared | F08b |
| R02 | A null beneficiary identifier quarantines | F25 |
| R02 | Quarantined documents stay usable, so they contribute facts | F08a, F08b (the result contract rejects the facts) |
| R02, R09 | Provenance failure checked before the metadata subject | Unit: mismatched metadata with failed provenance is quarantined |
| R03 | The beneficiary identifier is required (no name alternative) | F25 |
| R03 | Pass when no usable order exists | F02, F08b |
| R04 | A same-day order is sequenced from dates alone (C02) | F06, and the false-ready check (1 of 5) |
| R04 | The LCMP branch is ignored (C04) | F23 |
| R04 | No end-of-month clamping (C01) | Unit: six month-addition tests and five R04 boundary tests |
| R04 | Exclusive six-month upper bound (C01) | Unit: four inclusive-bound R04 tests |
| R05 | Pass when no receipt record is supplied | F02, F08b |
| R05 | The order date span ends a day later (C06) | F01, F06, F08a, F22, F23, F25 |
| R06 | The clinical finding selects human review | F01, F02, F22, F25 |
| R07 | A stated LCMP incorporation is ignored | F23 |
| R08 | The supported assessment date check is inverted | All eight |
| R09 | Hash over re-serialized JSON instead of the exact bytes | All eight |
| R09 | Any MIME type is accepted | Unit: three plain-text tests |
| State | Missing evidence outranks human review | F08b |
| C07 | An R02 conflict names no document | F08a, F08b |
| PA-A03 | `originalText` re-serializes strings | All eight |
| Fix | A pack rule missing an outcome for a reportable status is accepted | Unit: the R05-without-conflict pack is rejected |
| Fix | The outcome backstop drops a held condition without an outcome | Unit: `selectOutcome` refuses it |
| Fix | Locators are compared with the Zod-trimmed body | Unit: both padded-string tests |
| Fix | R02 compares the trimmed parsed name | Unit: a padded name quarantines |
| Fix | A quarantined ID with a usable version is not refused | Unit: the stated refusal |
| Fix | The contract-parsed (trimmed) result is returned | Unit: padded text is quoted exactly |
| Fix | The harness accepts facts from an unavailable document | Harness: the unreadable access tamper |
| Fix | The harness accepts a body kind that differs from its metadata | Harness: the body kind tamper |
| Fix | Refused oracles count in the false-ready denominator | Harness: the refused-oracle count |
| Fix | An incomplete false-ready count is stated as a result | Harness: both refused-oracle summary tests |
| Fix | R05 passes at the same instant as a stated order time | Unit: the equal-instant receipt |
| Fix | R07's pass text ignores the pack scope | Unit: the wider-scope pack |

The harness rejections are permanent tests in `evals/src/harness.test.ts`, all
on in-memory copies: a dangling `evidenceFactIds` reference, an appended fact
from the quarantined F08a attachment, quarantined text and document references
outside R02, facts whose value, original text or version no longer match the
source, a one-byte change to an oracle and to the policy pack (both refused
before any comparison), a changed status, citation, affected document or
missing finding, the false-ready arithmetic, facts from an unavailable,
unsupported or mismatched-kind document, a refused oracle (excluded from both
counts and reported as `False-ready: not computed`), and an oracle file on disk
without a frozen hash. `packages/domain/src/calendar.test.ts` checks that
`instantOf` reads exactly the timestamps the installed contracts accept, across
about 4,600 generated forms.

### Container experiments

The measured column records one passing run. Later runs vary within each group's
accepted outcomes: in one, group 3 logged 6
exits with code 1, group 11 exited 1 and group 12 counted 266 project files.
The test assertions, not these figures, are the contract.

| Group | What it proves | Measured |
| --- | --- | --- |
| 1 | `init` exits 0, `app` turns healthy, page and `GET /api/status` carry the build revision, the web port is bound to `127.0.0.1` only, `db` has no host port, a probe completes | fresh project healthy in 6 s |
| 2 | `kill -KILL` of web, API or worker stops the container with 137 and the restart policy brings back a healthy unit | each exit about 3.2 s after the kill; healthy again after 6 s (Docker's restart delay varies; up to 36 s in an earlier run) |
| 3 | `DATA_MODE=live` exits 1 with a value-free message and never becomes healthy | 5 exits with code 1 in 25 s |
| 4 | A fresh heartbeat row from a stopped worker does not satisfy a new API process (`worker_heartbeat_missing`); a `SIGSTOP`ped worker trips the watchdog | row 4.6 s old; container stopped with 124 after 46.5 s (bound 65 s) |
| 5 | With `db` stopped: 503 `database_unavailable` from readiness and status, the page says the database is unavailable, submissions refused, the watchdog logs the database address derived from the API's URL (`db:5432`) at start and a pause with its own connection error to it, no restart past the watchdog limit; recovery without restart | outage held 47 s; readiness back 5 s and Docker health 12 s after `db` started; watchdog address `db:5432` |
| 6 | With a job active (8 s delay, one worker slot): submissions refused with `shutting_down`, readiness reports it, no new job claimed, the job completes through the internal route, exit 0. With a 45 s job: the drain deadline returns it to `retry`, the worker's stopping line carries the compiled drain and exit deadlines, and it logs `worker stopped` within 2 s after the drain deadline and before its forced exit (which never fires), the probe stays `queued`, and a new process completes it. The worker's compiled forced exit comes at least 5 s after its drain deadline and before its `timeout-down`; the s6 `timeout-down` values plus `S6_KILL_GRACETIME` leave at least 5 s of the 60 s stop grace period | `docker compose stop app` 10.9 s; past the deadline 30.3 s, worker stopped 27.0 s after SIGTERM (drain deadline 27 s, forced exit 33 s, not fired); worst case 55 s (36.4 s past the deadline in an earlier run with a 30 s drain) |
| 7 | Probes and an evidence-volume file survive `down` plus `up` and `up --force-recreate`; `init` logs "exists; roles and grants reapplied" and 0 migrations applied | 7 probes and the marker kept both times |
| 8 | `app` and `init`: user 10001, read-only root, `cap_drop: ALL`, `no-new-privileges`, no Docker socket, no Docker init; every process uid 10001 with zero effective and bounding capabilities and `NoNewPrivs: 1`; only `/run`, `/tmp` and the evidence volume are writable | 15 processes; PID 1 `s6-svscan` |
| 9 | No secret or canary in served pages and scripts, the exported image filesystem, every saved layer (decompressed), history, image and container inspect output, or any service log; a canary copied into a throwaway image is found in both its saved layer and its filesystem; credential matrix per container and per running process (from each launcher's start log); TCP rules all `scram-sha-256`; wrong passwords refused with 28P01; an admin credential in `app` refused with exit 1 | 14 served files, 324 MB filesystem, 19 compressed layers in 28 saved files |
| 10 | With an `ACCESS EXCLUSIVE` lock held on `pa_app.pilot_probes` and `db` healthy: readiness reports `database_check_failed`, not `database_unavailable`, the watchdog does not pause, and it stops the container with 124; recovery after the lock is released | container stopped with 124 46.7 s after the lock was taken (bound 75 s) |
| 11 | With a lock held on `pgboss.version`, a recreated `app` never becomes ready: s6-overlay's 120 s startup limit stops it within 120 to 140 s and no watchdog ever starts. The exit code matches the s6 timer that fired first: 2 with "s6-rc: fatal: timed out", or 1 with "unable to start service api: command exited 99" from `s6-svlisten` (a race between two timers on the same deadline; neither outcome is rare, see [operations.md](operations.md#health) for the observed counts). In the restarted, still blocked container, killing the API exits 137, not stage 2's own code | exit 2 after 123.2 s; the killed API exited the restarted container with 137 |
| 12 | The runtime image holds no workspace devDependency that no workspace package needs at runtime (and no `@vitest/`, `@typescript-eslint/`, `@eslint/`, `eslint-`, Playwright, `@tailwindcss/` or esbuild package), no TypeScript source or test file of the project, and no `.env*` or `.secrets` anywhere | 93 installed packages and 245 project files, none flagged |
| 13 | No secret or canary in the image build output or in the saved logs of every container the run created, including the ones later replaced | 7 kB of build output (a cached build) and the logs of 19 containers, no findings |

Each group was also observed failing for the right reason with a temporary
mutation, run by itself and then reverted (file restored byte for byte):

| Group | Mutation | Observed failure |
| --- | --- | --- |
| 1 | Port published as `${APP_HOST_PORT:-3105}:3105` | Port binding not limited to `127.0.0.1` |
| 2 | Finish script exits 0 before halting | Timed out waiting for the web kill to stop the container |
| 3 | Launcher stops passing `DATA_MODE` | Container became healthy |
| 4 | Watchdog hang limit 300 s | Timed out waiting for the watchdog |
| 5 | Watchdog no longer pauses for `database_unavailable` | Container stopped with 124 during the outage |
| 6 | `drain` down step replaced with `true` | No submission refused with `shutting_down` |
| 6 | Worker drain deadline 50 s | No drain-deadline log; the long job was not returned to the queue |
| 7 | Evidence volume replaced by an anonymous volume | Evidence marker missing after `down` and `up` |
| 8 | `read_only: false` | `ReadonlyRootfs` false |
| 9 | Launcher passes `DATABASE_URL_WORKER_FILE` to web | Web credential list not empty |

Review fixes added or changed the tests below. Each was observed failing
under its own mutation of the working tree, run by
itself and then reverted byte for byte:

| Test | Mutation | Observed failure |
| --- | --- | --- |
| Unit `apps/api/src/health.test.ts` | Pool exhaustion ("timeout exceeded when trying to connect") classified as a connection failure | "reports a full connection pool as database_check_failed" failed |
| 5 | Watchdog's own TCP check always reports `db:5432` reachable | Container stopped with 124 during the outage |
| 6 | Worker `timeout-down` 45 s | Worst case 65000 ms, above the 55000 ms limit |
| 9 | Launcher passes `DATABASE_URL_WORKER_FILE` to web | Web start log listed `DATABASE_URL_WORKER_FILE` |
| 10 | Watchdog treats every database reason as an outage, without its TCP check | Timed out after 120 s waiting for the watchdog to stop the container |
| 11 | `S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0` | Timed out after 200 s waiting for the startup bound to stop the container |
| 11 | `pa-halt` no longer makes the exit code file read-only | API killed during the blocked startup: exit 1, expected 137 |
| 12 | API TypeScript sources copied into the runtime image | Seven `/app/apps/api/src/*.ts` files listed |
| 13 | Worker logs its database URL at startup | Finding `secret worker role password` in the app container's logs |

Follow-up fixes changed or added the container tests below. Each was
observed failing under its own mutation, run by itself and then reverted byte
for byte:

| Test | Mutation | Observed failure |
| --- | --- | --- |
| 5 | API launcher no longer writes `/run/pa/database-address` | The watchdog never paused: container stopped with 124 during the outage |
| 6 (shutdown budget) | Forced exit 4 s after the drain deadline | Exit minus drain deadline 4000 ms, below 5000 ms |
| 6 (past the deadline) | Worker cleanup after the drain hangs 10 s, so the forced exit at 33 s fires | Log contains "worker did not exit after its drain deadline" |
| 6 (past the deadline) | `main.ts` forces its exit at `EXIT_DEADLINE_MS - 5_000` instead of the constant | Logged deadlines `[27000, 28000]`, expected `[27000, 33000]` |
| 6 (past the deadline) | `main.ts` drains for `drainDeadlineMs + 3_000` (log unchanged) | Worker stopped 30027 ms after SIGTERM, not below 29000 |
| 11 | `S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0`, against the assertion keyed on the exit code | Timed out after 200 s waiting for the startup bound to stop the container |

A forced exit only 100 ms after the drain deadline did not fire: the worker
logged `worker stopped` 27024 ms after SIGTERM, 24 ms after the deadline, so that
mutation was replaced by the slow cleanup above. A mutation leaving
`EXIT_DEADLINE_MS` unused failed the image build (unused import), not the test,
so it was replaced by the `- 5_000` variant. Group 11's exit-1 branch cannot be
forced by a mutation; its classification was checked against the saved logs of
two exit-1 runs and one exit-2 run, and every mismatched pair of code and line
was rejected.

Group 9 also failed on its first run against the unchanged design: the official
PostgreSQL image's default `pg_hba.conf` trusts TCP connections from `127.0.0.1`
and `::1` inside the `db` container. `compose.yaml` now passes
`POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256`, so every TCP rule uses
`scram-sha-256` and only the Unix socket keeps `trust`.
