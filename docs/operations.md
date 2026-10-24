# Local operations

This guide covers the local Compose deployment: one application
image (Next.js web, Fastify API and pg-boss worker under s6-overlay) beside
PostgreSQL. It packages the complete offline case workflow, the
operator workbench and the optional recorded agent, and seeds a synthetic demo
queue ([demo walkthrough](demo.md)). It runs synthetic fixture data only, with
no payer connection, model call or external account. Historical command evidence
comes from macOS (darwin-arm64), Docker 29.8.2 and Compose v5.6.0. The
troubleshooting table and [recorded verification](#recorded-verification)
identify what was
actually exercised; they do not establish a pass on the current source revision.

## Start

From a clean clone with Docker, Compose, a POSIX shell, Git and curl (no host Node),
and no retained deployment using this project name:

```sh
cp .env.example .env          # optional settings; empty values mean defaults
scripts/init-secrets.sh       # random secrets in ./.secrets (refuses to overwrite)
PA_BUILD_REVISION="$(git rev-parse HEAD)" docker compose up --build -d --wait
curl -s http://127.0.0.1:3105/api/status   # "build":{"revision":"<that commit>"}
```

Open `http://127.0.0.1:3105/`. `db` becomes healthy, `init` provisions roles and
the database and migrates, then exits 0, and `app` starts and turns healthy once
readiness passes; `--wait` returns then. Without `-d --wait`, `docker compose up
--build` runs in the foreground. `PA_BUILD_REVISION` (from the shell, as above,
or from `.env`) labels the image and is shown on the page and in
`GET /api/status`; it defaults to `unknown`.

`scripts/init-secrets.sh` writes `postgres_password`, the four role connection
URLs, `worker_service_token` and `better_auth_secret` (the API's session signing
secret) to `.secrets` in the repository root, where
`compose.yaml` looks by default, from any working directory. `--dir DIR` writes
to `DIR` relative to the current directory. A `PA_SECRETS_DIR` in the shell is
used too; when relative, it is taken from the repository root, as Compose
resolves it. The script does not read `.env`, so a `PA_SECRETS_DIR` set only
there needs the same value passed with `--dir`, and it prints the absolute
directory it wrote. It generates every value before writing anything and stops
if `/dev/urandom` does not yield 32 bytes for one of them, then writes all seven
files under temporary names first, so a failure while generating or writing
them leaves the existing files untouched; the final moves are not atomic as a
set, and a move failing part way needs a rerun. The directory is mode 0700 and
Git-ignored. The
files are 0644 inside it because Compose bind-mounts file secrets with their
host owner and mode (outside Swarm it ignores `uid`, `gid` and `mode`), and the
database (uid 999) and application (uid 10001) containers must read them. The
helper refuses to overwrite existing files; `--force` replaces them, which also
needs the [reset](#destructive-reset) for an existing database because
PostgreSQL applies its bootstrap password only when the volume is first
initialised.

### Demo queue and agent settings

When the API starts it seeds seven synthetic cases idempotently (five fixtures
plus `case-f02-loop` and `case-agent-demo`, see [the demo](demo.md)) and logs
`synthetic demo cases seeded` with the number created. Existing cases, including
cancelled ones, are never changed by the seed.

`AGENT_GRAPH_PROVIDER` (in `.env`, default `off`) selects the agent graph:
`recorded` replays the packaged scripted-fixture recording through the
LangGraph graph, and `live` enables packaged live Claude as described in
[live accounting](#live-accounting); `anthropic` is refused at startup. With
`off`, starting a run answers 409 `capability_disabled` with reason
`agent_graph_disabled` and the capability state. Outside `live`, a live request
answers 409 `capability_disabled` with reason `live_provider_disabled`.
`AGENT_RUN_BUDGET_USD`, `AGENT_DAILY_BUDGET_USD` and `AGENT_TOTAL_BUDGET_USD`
accept only 0 outside `live`, and the per-run bounds
`AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_MODEL_CALLS` and `AGENT_MAX_RUN_SECONDS` can
only be lowered. The launcher passes these settings to the API and worker only.
It never passes a provider key or a LangSmith or LangChain tracing variable, and
both services refuse to start if tracing is enabled. `GET /api/status` reports
the configured provider as `modes.agentGraph` (`off`, `recorded` or `live`) and the
`/pilot` page shows it as "agent graph"; `modes.agent` stays `rules`, the
`AGENT_MODE` baseline that assesses every case.

The worker keeps LangGraph checkpoints in the `pa_checkpoint` schema (worker
role only). Checkpoints hold the synthetic source bodies a run read, so they
live and die with the database volume: `down -v` is their cleanup.

## Configuration reference

[.env.example](../.env.example) lists implemented configuration only. Compose
loads `.env` for interpolation; API/worker entries, test helpers and shell scripts
read exported variables and do not load the root `.env`. Do not bulk-source the
example: credentials are per process and some CLI options distinguish unset
from empty. Commented entries describe host-only or packaging-owned inputs,
not extra settings forwarded by Compose. No local `.env` is committed.

### Deployment and runtime

| Variable | Reader | Default or constraint |
| --- | --- | --- |
| `APP_HOST_PORT` | Compose port mapping | `3105`, loopback only |
| `PA_PUBLIC_ORIGIN` | Compose, API config, web BFF/launcher | `http://127.0.0.1:3105`; change with host port; exact loopback origin |
| `PA_IMAGE_TAG` | Compose, demo smoke | `local` in Compose; `smoke` in smoke wrapper |
| `PA_BUILD_REVISION` | Compose build arg, Dockerfile, API config/launcher | `unknown`; 1-64 letters/digits/periods/underscores/hyphens |
| `PA_BUILD_CREATED` | Compose build arg, Dockerfile label | `unknown` |
| `PA_SECRETS_DIR` | Compose secret paths, init helper; restore failure guidance | `./.secrets`; scripts need it exported or passed explicitly |
| `COMPOSE_PROJECT_NAME` | Compose, backup and restore helpers | `prior-authorization`; explicit `--project` takes precedence in helpers |
| `APP_ID` | Core config, launcher | Required `prior-authorization`, fixed by Compose |
| `DATA_MODE`, `AUTH_MODE`, `AGENT_MODE` | Core config, launcher, Compose | `fixture`, `fixture`, `rules`; other modes refused |
| `LOG_LEVEL` | Core config, launcher, Compose init/app | `info`; fatal/error/warn/info/debug/trace/silent |
| `WORKER_CONCURRENCY` | Worker config, launcher, Compose | `2`, integer 1-16 |
| `AGENT_GRAPH_PROVIDER` | Agent config, launcher, Compose | `off`; `off`, `recorded` or `live` (live only through `compose.live.yaml`) |
| `AGENT_RUN_BUDGET_USD`, `AGENT_DAILY_BUDGET_USD`, `AGENT_TOTAL_BUDGET_USD` | Agent config, launcher, Compose | `0` outside live; with live, positive and at most 10, 20 and 20 USD, required by the overlay; below USD 5.16384 (one attempt) live runs are refused |
| `PA_ACCOUNTING_DIR` | `compose.live.yaml` | Required for live, no default: host directory outside the checkout and every app volume, holding the migrated ledger |
| `PA_ANTHROPIC_API_KEY_HOST_FILE` | `compose.live.yaml` | Required for live, no default: host path of the key file, mounted read-only |
| `PA_ACCOUNTING_LEDGER_FILE` | API config, launcher (API only) | Unset outside live; absolute path of the canonical ledger; refused by the worker |
| `PA_ANTHROPIC_API_KEY_FILE` | Worker config, launcher (worker only); evaluation CLI | Unset outside live; absolute path, read only when a live run starts; refused by the API |
| `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_MODEL_CALLS`, `AGENT_MAX_RUN_SECONDS` | Agent config, launcher, Compose | Defaults/maxima 10/6/180 respectively; integer at least 1 |
| `LANGSMITH_TRACING`, `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING`, `LANGCHAIN_TRACING_V2` | Agent config for host API/worker and evaluation | Unset or `false`; launcher does not forward them |

### Credentials

Core config reads each name below inline or through `NAME_FILE`, rejecting both
together. Prefer ignored files. The launcher accepts only API/worker-owned
credentials for the respective process and rejects admin/migrator/bootstrap
credentials anywhere in `app`. [.env.example](../.env.example) lists names and
blank file-path references, never values. These are not shared `.env` secrets.

| Names, each with optional `_FILE` suffix | Reader and scope |
| --- | --- |
| `DATABASE_URL_ADMIN` | Provisioner only; forbidden in app |
| `DATABASE_URL_MIGRATOR` | Provisioner and migrator only; forbidden in app |
| `DATABASE_URL_API` | Provisioner and API; forbidden in worker |
| `DATABASE_URL_WORKER` | Provisioner and worker; forbidden in API |
| `WORKER_SERVICE_TOKEN` | API and worker |
| `BETTER_AUTH_SECRET` | API session signing, minimum 32 characters; forbidden in worker |
| `PA_EVALUATION_ADMISSION_TOKEN` | API, optional in live mode, minimum 32 characters; enables the evaluation admission routes; forbidden in worker |
| `POSTGRES_PASSWORD` | PostgreSQL image uses `_FILE` in normal Compose, inline only from the disposable test password in test Compose; launcher forbids either in app |

### Tests, demo and paid evaluation

Export host-only inputs in the shell that runs the relevant command. Merely
copying the example does not supply them. Keep database URLs and key/ledger
paths out of logs and committed files.

| Variable | Reader | Requirement or default |
| --- | --- | --- |
| `PA_TEST_POSTGRES_PASSWORD` | Test Compose and `packages/db/src/testing.ts` | Required for default disposable server, applied on first initialization |
| `PA_TEST_ADMIN_DATABASE_URL` | Test database helper | Optional full admin URL for another disposable server; overrides password URL |
| `PILOT_TEST_JOB_DELAY_MS` | Worker config/launcher, container override | `0`, integer 0-120000; fixture mode only |
| `PA_CTEST_JOB_DELAY_MS`, `PA_CTEST_WORKER_CONCURRENCY` | Container-test Compose override | Harness supplies `0` and `2`; not read from the caller's `.env` by the harness |
| `PA_DEMO_ORIGIN` | `scripts/demo/walkthrough.mjs` | Unset defaults to `http://127.0.0.1:3105`; smoke wrapper sets it from `--port`; empty is invalid |
| `PA_ANTHROPIC_API_KEY_FILE` | Live evaluation config and provider client | Required absolute key-file path for separate paid evaluation |
| `PA_ADMISSION_API_ORIGIN` | Live evaluation config | Required exact loopback origin of a running live-mode API |
| `PA_EVALUATION_ADMISSION_TOKEN_FILE` | Live evaluation config | Required readable token file, the same token the API holds |
| `PA_ANTHROPIC_LEDGER_FILE` | Live evaluation config, API config | Retired: refused, since the evaluation command no longer holds a ledger |
| `PA_LIVE_RUN_CAP_USD` | Live evaluation config | Positive amount at most USD 10, further limited by the API's day and lifetime caps |
| `PA_LIVE_EFFORT` | Live evaluation config | `low`, `medium` (default), `high` |
| `PA_LIVE_CASES` | Live evaluation entry | Optional comma-separated subset; unset selects registered suite |
| `PA_LIVE_RUN_LABEL` | Live evaluation entry | Unset defaults to `full`; 1-40 lowercase letters/digits/hyphens; empty invalid |
| `PA_LIVE_PROMPT_NOTE` | Live evaluation entry/report | Optional factual note, never secrets or model reasoning |

The `PA_LIVE_*` variables configure only `pnpm test:evals:live`, not packaged
operation. Project caps remain USD 10/run, USD 20/UTC day and USD 20 lifetime.
Preserve all actual spend and unknown reservations. See
[live evaluation](development.md#live-claude-evaluation) for current limitations.

### Packaging-owned and inherited variables

These are intentionally not active `.env` options. Dockerfile fixes `NODE_ENV`,
`NEXT_TELEMETRY_DISABLED`, build-stage `CI` and `PATH`, `EVIDENCE_ROOT` and
`S6_READ_ONLY_ROOT`, `S6_BEHAVIOUR_IF_STAGE2_FAILS`,
`S6_CMD_WAIT_FOR_SERVICES_MAXTIME`, `S6_KILL_GRACETIME`, `S6_VERBOSITY`.
`EVIDENCE_ROOT` labels the mount location; application document bytes currently
live in PostgreSQL. The launcher retains `PATH`, allowlists `NODE_ENV` and `TZ`
for services, and fixes web `HOSTNAME=0.0.0.0`, `PORT=3105`. `TZ` is not wired
through Compose, and domain assessment must remain timezone-independent.
The launcher only forwards `NEXT_TELEMETRY_DISABLED` to web.

Compose fixes PostgreSQL's `POSTGRES_USER`, `POSTGRES_DB` and
`POSTGRES_INITDB_ARGS`; tests set their own bootstrap password. Docker build
arguments `NODE_IMAGE`, `POSTGRES_IMAGE`, `TARGETARCH` and automatic
`BUILDPLATFORM` belong to build/platform selection, not runtime `.env`.

The container harness inherits `PATH`, `HOME`, `DOCKER_HOST` and `DOCKER_CONTEXT`
for Docker tooling; smoke uses `TMPDIR` for scratch space. The lock-test harness
sets `PGAPPNAME` internally. Secret-canary names `PA_CANARY_TOKEN` and
`NEXT_PUBLIC_PA_CANARY` are generated test markers, not configuration. The smoke
wrapper unsets `ANTHROPIC_API_KEY` and `LANGSMITH_API_KEY`; neither configures the
explicit file-keyed provider. No generic provider-key environment variable or
unimplemented live setting belongs in the deployment template.

## Submit a synthetic probe

The diagnostic `/pilot` page exchanges a synthetic `PilotProbe` transport record,
separate from the case workflow: no clinical evidence or payer action. On
`http://127.0.0.1:3105/pilot`, select
**Submit synthetic probe**, then **Refresh status**; the probe moves from Queued
to Completed by worker. From a shell, post a label of 1 to 80 characters with an
`Idempotency-Key` header of 16 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` or
`-`:

```sh
curl -s -X POST http://127.0.0.1:3105/api/pilot/probes \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: probe-$(openssl rand -hex 12)" \
  -d '{"label":"operator check"}'
curl -s http://127.0.0.1:3105/api/status     # the probe: queued, then completed
```

A new probe answers 201. Repeating the request with the same key and body
answers 200 with `"replayed":true` and creates nothing; the same key with a
different body answers 409 `idempotency_conflict`. A missing or malformed key
answers 400 `invalid_idempotency_key`, any other body (an extra field, an empty
label) 400 `invalid_request`, and a body over 16 KiB 413 `payload_too_large`.
While the container stops, submissions answer 503 `shutting_down`; during a
database outage they answer 503 as well.

## Topology

| Service | Image | Role |
| --- | --- | --- |
| `db` | `postgres:18.6-bookworm` by digest | Data volume `db-data` at `/var/lib/postgresql`; no host port |
| `init` | `prior-authorization-app` | One-off: provision roles and database idempotently, migrate as `pa_migrator`, exit |
| `app` | `prior-authorization-app` | Web on `127.0.0.1:${APP_HOST_PORT:-3105}`; API on container loopback 4105; worker; watchdog |

Compose project `prior-authorization`, volumes `prior-authorization_db-data` and
`prior-authorization_evidence` (mounted at `EVIDENCE_ROOT=/var/lib/app/evidence`),
network `prior-authorization_default`. `app` starts only after `db` is healthy and
`init` has completed successfully. Re-running `init` on an initialised database
reapplies roles and grants and applies only pending migrations; it never resets
data.

## Credential matrix

| Container or process | Receives |
| --- | --- |
| `db` | `POSTGRES_PASSWORD_FILE` (bootstrap superuser); password authentication, never `trust` for TCP |
| `init` | `DATABASE_URL_ADMIN_FILE`, `DATABASE_URL_MIGRATOR_FILE`, `DATABASE_URL_API_FILE`, `DATABASE_URL_WORKER_FILE` |
| `app`: API process | `DATABASE_URL_API_FILE`, `WORKER_SERVICE_TOKEN_FILE`, `BETTER_AUTH_SECRET_FILE`; with the live overlay also `PA_ACCOUNTING_LEDGER_FILE` |
| `app`: worker process | `DATABASE_URL_WORKER_FILE`, `WORKER_SERVICE_TOKEN_FILE`; with the live overlay also `PA_ANTHROPIC_API_KEY_FILE` |
| `app`: web process | no database credential, worker token or session secret |
| `app`: watchdog | none |

`compose.yaml` mounts the API URL, worker URL, worker token and Better Auth secret into `app`.
s6-overlay starts services with an empty environment and keeps the container
environment as files; `docker/rootfs/usr/local/lib/pa/launch.mjs` copies a
per-service allowlist from there and imports the service in the same process, so
s6 supervises the service itself. The launcher refuses to start any service when
an admin, migrator or bootstrap credential variable reaches the container at all.
The API and worker configuration still refuse each other's credentials. Each
launcher logs the variable names (never values) its service process holds when
it starts. The container tests check all of this from those log lines, and that
a wrong password is refused (28P01).

This separation is configuration hygiene, not isolation. Every process in `app`
runs as uid 10001, and the four secret files mounted into `app` are readable by
that uid, so any app process, including a compromised web server, can read the
API URL, worker URL, worker token and session secret from `/run/secrets`. The matrix
keeps credentials out of the environments of services that do not use them,
which keeps the configuration checks meaningful; processes in one container are
not sandboxes from one another. The admin and migrator credentials never enter
`app` at all.

The `db` image keeps its default `trust` rule for the Unix socket inside the
container; it is reachable only through `docker exec` into `db`, which already
needs host-level Docker access. All TCP rules use `scram-sha-256`.
`POSTGRES_INITDB_ARGS` (like the bootstrap password) applies only when PostgreSQL
initialises an empty volume: a `db-data` volume created before it was added
(earlier builds) keeps the image's `trust` rule for `127.0.0.1`. Recreate
such a disposable volume with the [destructive reset](#destructive-reset).
For retained data, preserve a verified backup and plan a reviewed migration;
do not delete it to change an authentication setting.

## Health

| Endpoint | Meaning |
| --- | --- |
| `GET /api/health/live` | The web server and the API process answer (the public route goes through the web proxy); never touches the database |
| `GET /api/health/ready` | 200 `{ ready: true }` only when web and API answer, the database is reachable with the expected application and queue schema, and the worker has sent a heartbeat to this API process within 15 s; otherwise 503 with `reasons` |

Readiness reasons:

| Reason | Meaning |
| --- | --- |
| `shutting_down` | The container is stopping (see [Shutdown](#shutdown)) |
| `database_unavailable` | A connection-level failure: the server cannot be reached (refused, unknown host, DNS retry, reset, socket timeout, host or network unreachable), closed the connection, or refused it with SQLSTATE class `08` or `57P` (shutdown, starting up, recovery) |
| `database_check_failed` | The 3-second check failed without a connection-level error: a lock wait or slow query, an exhausted connection pool, a cancelled statement, too many connections or any other error |
| `schema_incompatible` | A table or schema is missing, a privilege is missing, or the queue schema version changed since startup |
| `worker_heartbeat_missing`, `worker_heartbeat_stale` | No heartbeat from the worker to this API process, or none within 15 s |

The worker reports a heartbeat every 5 s; the API keeps heartbeats in memory, so
a row left in the database by an earlier process never counts. A worker that
dies still counts for up to 15 s after its last heartbeat; in the container a
worker exit stops the whole unit at once, so that window hides nothing there.

The Docker healthcheck (`docker/rootfs/usr/local/lib/pa/healthcheck.mjs`) calls
readiness through the web server every 10 s (every 2 s during a 60 s start
period) and marks the container unhealthy after 3 failures.

Docker does not restart an unhealthy container, so two bounds stop a unit that
never becomes ready or stops being ready, and the restart policy
(`unless-stopped`) starts it again:

- **Startup.** s6-overlay brings the services up in order and waits for the API
  and worker to report ready. `S6_CMD_WAIT_FOR_SERVICES_MAXTIME=120000` limits
  that wait to 120 s (s6-overlay 3.2.3.2 defaults to 0, waiting forever, in
  `/package/admin/s6-overlay/etc/s6-linux-init/skel/rc.init`). With
  `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`, stage 2 then records the exit code of
  `s6-rc` as the container exit code and stops the container. Two timers share
  that deadline, and either may fire first: `s6-rc`'s own timer makes it exit 2
  ("s6-rc: fatal: timed out"), while the `s6-svlisten` waiting for the blocked
  service exits 99, which `s6-rc` reports as "unable to start service api:
  command exited 99" (or `worker`) before exiting 1. Both stop the container
  about 123 s after it started, and neither outcome is rare. In 16 recorded runs
  of container test group 11 across several revisions, exit 1 came 5 times,
  including before those changes, so the race predates them. One of those runs
  was a full-suite run whose container logs were not kept, so only its exit code
  is known. The
  watchdog does not run yet during this phase.
- **Running.** Once every service is up, a watchdog service polls readiness every
  5 s. It arms on the first ready answer or 120 s after it starts. Once armed,
  readiness failing for 30 s stops the container with exit code 124. A stalled
  worker misses heartbeats for 15 s before readiness fails, so the container
  stops within about 50 s of the worker's last heartbeat; the container test
  bounds it at 65 s.

The watchdog pauses its clock only for a confirmed database outage: readiness
reports `database_unavailable` or `database_check_failed`, and the watchdog's
own TCP connection to the database (no credential, 2-second timeout) fails. It
connects to the host and port of the API's database URL (`db:5432` with
`scripts/init-secrets.sh`), which the API's launcher writes to
`/run/pa/database-address` and the watchdog logs in its `watchdog started` line.
Without that file the watchdog logs the address as unknown and never pauses, so
an outage then counts as a hang. The pause lasts as long as both hold;
restarting cannot fix an unreachable database, and the services reconnect when
it returns. A database that accepts TCP connections but cannot answer
readiness, such as a query blocked by a lock or an exhausted pool, is treated
as a hang: the container stops with 124 after 30 s.
So does a database that accepts connections but stays in startup or recovery
for more than 30 s; the restarted app can then only start once the database is
ready (this case is not exercised by the tests).

## Supervision and failures

s6-overlay 3.2.3.2 is PID 1. `api`, `web`, `worker` and `watchdog` are longruns;
`web` starts after the API reports ready, the worker after `web`. Every finish
script treats an unexpected exit as fatal: it records the exit status (128 plus
the signal number for a signal) as the container exit code, stops the whole
container with `/run/s6/basedir/bin/halt`, and tells s6 not to restart the
service. The first failure's code is kept when others follow during the same
shutdown: the halt helper makes the exit code file read-only after writing it.
That matters during startup, where a failed service also makes s6-overlay's
stage 2 fail and try to write its own code (1); the log then shows
`rc.init: ... cannot create /run/s6-linux-init-container-results/exitcode:
Permission denied`, which is expected. A configuration error makes the API exit
before it reports ready, so the container stops within seconds with a value-free
message such as `DATA_MODE=live is not supported by this build`.

## Shutdown

`docker compose stop` (or `down`) sends SIGTERM, and s6 brings services down in
reverse dependency order:

1. The watchdog stops, so an intentional shutdown is never reported as a hang.
2. The `drain` step sends SIGUSR2 to the API: readiness turns false with
   `shutting_down`, and `POST /api/pilot/probes` answers 503 `shutting_down`.
   The internal worker route stays open.
3. The worker stops claiming jobs (`offWork` with `wait: true`) and waits up to
   27 s for active jobs to finish and report through the API. At the deadline it
   calls `stop({ graceful: false })`, which fails the active jobs back to the
   queue for retry; a probe stays `queued`, never `completed`. The worker then
   closes its pools, logs `worker stopped` and exits. If that hangs, it forces
   its exit 33 s after SIGTERM, leaving 6 s to fail jobs back.
4. The web server stops, then the API closes its connections.

Worst case, every step takes as long as it may. Steps run one after another;
when a step reaches its s6 `timeout-down`, s6 stops waiting for it, and the final
`S6_KILL_GRACETIME` kills whatever is left:

| Step | Application bound | s6 `timeout-down` |
| --- | --- | --- |
| Watchdog | exits on SIGTERM | 2 s |
| `drain` (SIGUSR2 to the API) | one signal | 2 s |
| Worker | 27 s drain deadline, then exits by 33 s at the latest | 35 s |
| Web | exits on SIGTERM | 5 s |
| API | closes within 7 s or exits | 8 s |
| s6-overlay kill grace | | 3 s (`S6_KILL_GRACETIME`) |
| Total | | 55 s, inside Compose's 60 s `stop_grace_period` |

The worker's deadlines are `DRAIN_DEADLINE_MS` and `EXIT_DEADLINE_MS` in
`apps/worker/src/shutdown.ts`. Container test group 6 reads the s6 values and
those compiled deadlines from the running container and checks that the forced
exit comes at least 5 s after the drain deadline and before the worker's
`timeout-down`, and that the sum leaves at least 5 s of the grace period. The
unit test `apps/worker/src/shutdown.test.ts` checks the same from the repository
files. pg-boss 12.38.0 semantics, from its installed source:
`offWork(name, { wait: true })` stops fetching and resolves after running
handlers settle; `stop({ graceful: false })` fails work in progress with
"pg-boss shut down while active", aborts each job's signal and closes its pool.

Measured with `docker compose stop app`: 3.3 s with no active job (fresh-start
run before the timeouts above were tightened); in a later run, 10.9 s with an
8-second job active (container test group 6) and 30.3 s with a
45-second job, which the 27-second deadline returned to `retry`. In that run the
worker logged `worker stopped` 27.0 s after SIGTERM, so the forced exit at 33 s
did not fire (in an earlier run with a 30-second deadline and the exit 3 s after
it,
the same case took 36.4 s). Each stop exited 0. After the services stop,
s6-overlay waits its default `S6_KILL_GRACETIME` of 3 s for stray processes,
which accounts for most of the idle time.

## Database outage

With `db` stopped, readiness answers 503 with `database_unavailable`,
`GET /api/status` answers 503 `database_unavailable`, the page says "Database
unavailable: the API is running but probe status could not be read", and new
submissions are refused with 503. The processes keep running and the container
is not restarted: restarting cannot fix an outage, and the API, worker and queue
reconnect on their own. The watchdog pauses while it cannot open a TCP
connection to the database (`db:5432`) itself and logs `readiness paused for
database outage` with the connection error. It logs that line when the pause
begins, not on every poll. The pause can begin while `docker compose stop db`
is still running: under synthetic CPU load the line was once logged before the
database container had exited (about 0.1 to 0.2 s before the command
returned), with `ECONNREFUSED` from the stopping database. Search the logs
from before the stop, not from when it returned. When `db` returns, readiness
recovers without operator action (4 s after `db` started in container test
group 5, and Docker health 12 s after, on its next check). If the
database stays away, the container stays up and unhealthy; check `db` first.

A database that is up but cannot answer is different. With an `ACCESS EXCLUSIVE`
lock held on `pa_app.pilot_probes` from another session, readiness reports
`database_check_failed` while `db` stays healthy, and the watchdog stops the
container with 124 (container test group 10). After the restart, readiness fails
again until the lock is released. Find the blocking session from inside `db`:

```sh
docker compose exec db psql -U postgres -d prior_authorization -Atc \
  "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'"      # a blocked pid
docker compose exec db psql -U postgres -d prior_authorization -c \
  "SELECT pid, application_name, state, query FROM pg_stat_activity WHERE pid = ANY (pg_blocking_pids(<blocked pid>))"
```

A lock that blocks startup itself (for example on `pgboss.version`) is bounded by
the 120-second startup limit instead and stops the container with exit code 2
or 1, depending on which s6 timer fires first (see [Health](#health); group 11).

## Logs and status

```sh
docker compose ps                       # state and health of each service
docker compose logs -f app              # web, API, worker and watchdog output
docker compose logs init                # provisioning and migration
docker inspect --format '{{json .State.Health}}' prior-authorization-app-1
curl -s http://127.0.0.1:3105/api/health/ready
curl -s http://127.0.0.1:3105/api/status
```

Successful health and heartbeat requests are not logged. Logs never include
secret values: configuration errors name variables only, and probe submissions
log a 12-character digest of the idempotency key.

## Stop

```sh
docker compose stop     # stop containers, keep them and the volumes
docker compose down     # remove containers and network, keep the volumes
```

## Live accounting

Packaged live Claude is off by default and is never enabled by a key alone. It
needs the separate overlay, an existing ledger and three positive caps. Every
attempt reserves the full worst case (USD 5.16384), so each cap must be at least
that; a smaller cap leaves live runs refused with reason
`cap_below_attempt_ceiling`:

```sh
export AGENT_RUN_BUDGET_USD=6 AGENT_DAILY_BUDGET_USD=20 AGENT_TOTAL_BUDGET_USD=20
export PA_ACCOUNTING_DIR=/absolute/host/accounting PA_ANTHROPIC_API_KEY_HOST_FILE=/absolute/host/key-file
docker compose -f compose.yaml -f compose.live.yaml up -d
```

The ledger directory must be outside the checkout, the database volume and every
backup, restore and reset path. Nothing in the app creates a ledger: when it is
missing, unreadable, invalid, locked by another writer or at another path, the
API logs `live accounting state` with the reason, the capability reports
`accounting_unavailable` and live runs are refused while everything else keeps
serving. Recorded and off modes never open it.

Create the ledger once from the earlier `pa.anthropic-spend.v1` file with the
maintenance command, which needs a byte-identical retained copy and records the
path it was migrated for. For the packaged deployment, run it inside the image
with the in-container path, while `app` is stopped:

```sh
docker compose -f compose.yaml -f compose.live.yaml stop app
docker compose -f compose.yaml -f compose.live.yaml run --rm --no-deps \
  --entrypoint /usr/local/bin/node app /app/apps/api/dist/accounting/cli.js \
  migrate --ledger /var/lib/pa-accounting/ledger.json --source-copy /var/lib/pa-accounting/retained.json
```

Migration is lossless and idempotent: a rerun verifies every entry and reports
`already_migrated`. Run every writing command only while the API is stopped. A
ledger keeps the path it was migrated for, so maintain it through the same path
the API uses. Only a ledger used by a host-run API (for example for the
evaluation command) is maintained with the host form,
`pnpm accounting <status|migrate|recover> --ledger <host path>` after `pnpm build`.

The API holds an exclusive lock beside the ledger while it runs. A graceful stop
releases it. After a crash the next API takes over only when it can prove the
previous writer stopped (same host and process namespace, and that process is
gone or the machine rebooted); a recreated container cannot prove that, so the
lock is left in place and admission stays closed. Then confirm that the previous
API and any in-flight provider requests have stopped, keep `app` stopped and run:

```sh
docker compose -f compose.yaml -f compose.live.yaml run --rm --no-deps \
  --entrypoint /usr/local/bin/node app /app/apps/api/dist/accounting/cli.js \
  recover --ledger /var/lib/pa-accounting/ledger.json \
  --confirm-writer-stopped --confirm-dispatch-owners-stopped
```

Add `--clear-block` to clear a persisted block (clock regression, conflicting
usage, an over-ceiling or unsupported-billing incident) once it is understood,
and `--remove-temporary-files` to delete abandoned replacement files. Recovery
releases only reservations from earlier writers that never received a grant.
Every attempt that might have reached the provider, and every unknown hold,
stays held in full; maintenance never releases them. `status` prints counts and
amounts only.

Live runs stop rather than continue after an interruption: a run whose worker or
API stopped during investigation fails as `interrupted_before_review`. A run that
reached human review resumes without any model client. Backups never include
the ledger, and restoring an older database cannot return spent budget: its
attempt slots are refused as replays. `backup.sh` and `restore.sh` use the base
Compose file, so a restored deployment starts with live mode off.

## Destructive reset

This is also the demo reset: on the next start the seed recreates the seven
synthetic cases. It deletes the deployment's database (including sessions and
`pa_checkpoint`) and evidence. It removes the containers,
the network `prior-authorization_default` and the volumes
`prior-authorization_db-data` and `prior-authorization_evidence`:

```sh
docker compose -p prior-authorization down -v
```

Then replace the secrets if needed (`scripts/init-secrets.sh --force`) and start
again. Nothing resets a volume silently. The reset never touches the live
accounting ledger, which is not a Compose volume.

## Backup and restore

The source blobs, revisions, packets, requests, receipts, sessions, queue jobs
and agent checkpoints all live in the `prior_authorization` database; the
`evidence` volume is included for completeness (the current build writes no
files to it).

```sh
scripts/backup.sh --project prior-authorization --out ./backup-2026-10-21
scripts/restore.sh --project prior-authorization-restored --from ./backup-2026-10-21
```

`backup.sh` stops `app` for a consistent copy, writes `db.dump` (`pg_dump -Fc`
through the `db` container's Unix socket, so no credential is read), streams
`evidence.tar` out of the app image, writes a `MANIFEST` with SHA-256 hashes and
the Git revision, then starts `app` again. `restore.sh` checks the manifest,
refuses a project that already has volumes, starts PostgreSQL on fresh volumes,
provisions roles, runs `pg_restore`, unpacks the evidence and starts the
deployment; `init` applies any pending migrations and the seed leaves restored
cases alone. Use the secrets directory of the backed-up deployment (role
passwords and the session secret live there, not in the dump): with it, existing
sessions stay valid. Run both from the repository root with the deployment's
environment (`.env`, `PA_SECRETS_DIR`, `PA_IMAGE_TAG`). A backup holds synthetic
case data and session rows: keep it local and delete it when done.
`scripts/demo/smoke.sh` exercises both commands, including a waiting agent run
that completes after the restore.

A restore that fails part way (for example in `pg_restore` or provisioning)
leaves the target project's new volumes behind, and a rerun refuses them. Remove
the failed target with `docker compose -p <target> down -v` before retrying,
naming only the restore target and never the live project. `restore.sh` prints
that command when it fails after the fresh-project check.

## Workflow operations

- **Stop and start.** `docker compose stop` and `docker compose up -d --wait`
  keep every case, request, receipt, session and checkpoint. The smoke checks
  that states, revisions, packet and source hashes and the single receipt are
  unchanged, and that a waiting agent run is still waiting.
- **Cancellation.** The operator's **Cancel case** is terminal: unresolved
  requests are cancelled, a queued delivery finds no approval and records no
  receipt, a later fixture reply is kept as audit-only, and assessment or
  recovery answers 409.
- **Failed read or delivery.** A source that is withheld, restricted or fails
  its hash check is never shown or used (404, or 409 on a hash mismatch;
  labelled unreadable or not authorized in the workbench). A delivery or assessment job that fails moves the
  case to `recoverable_error` with an `operator_action_required` event;
  **Recover** reassesses the current bytes and requires unexecuted approvals to
  be redrafted and approved again.
- **Stale packet or approval.** Approvals and review decisions bind the case
  revision, source revision, policy and packet hashes. Any change answers 409
  `conflict` and the workbench keeps the earlier preview with a text message.
- **Unresolved request.** When a reply does not resolve its rule, **Close
  unresolved request** (operator) closes the delivered request so a follow-up
  draft is allowed. Nothing is sent either way.
- **Stranded agent run.** If a run stays queued, running or resuming (for
  example after a lost status report), the operator's **Cancel this run**
  detaches its job: later worker reports and reviews for it are refused, and a
  new run can start.
- **Restart and recovery.** Jobs survive restarts in the pg-boss queue; a
  delivery interrupted after its receipt replays the same receipt. Agent runs
  waiting for review hold no job and resume from their checkpoint after review.
- **Retention.** No retention job runs. Everything stays in the volumes until
  `down -v`; sessions expire 8 hours after sign-in.
- **No key, live mode disabled.** The deployment starts and runs the whole demo
  without any model key. No provider key is read, no live client is
  constructed, and budgets are fixed at 0.

## Troubleshooting

| Symptom | Cause and fix | Observed |
| --- | --- | --- |
| `init` exits 1 with an authentication error | The `db-data` volume was initialised with an older `postgres_password`. Restore the old secrets or run the destructive reset. | Reproduced: after `scripts/init-secrets.sh --force` against an existing volume, `docker compose up -d --force-recreate init` exited 1 with `init failed: password authentication failed for user "postgres"` |
| `init-secrets: refusing to overwrite existing secrets` | Secrets exist already. Keep them, or use `--force` with the reset above. | Reproduced |
| `app` exits 1 with `Invalid configuration:` | A setting in `.env` or the shell is unsupported; the message names the variable. | Reproduced with `DATA_MODE=live docker compose up -d app`; also container test group 3 |
| `app` exits 1 with `launch: the app container must not receive ...` | An admin or migrator credential was added to the `app` environment; remove it. | Container test group 9 |
| `app` unhealthy with `database_unavailable` | `db` is down or unreachable; start it (`docker compose start db`). | Container test group 5 |
| `app` restarts with exit code 124 | The watchdog stopped a unit whose readiness stayed failed for 30 s; the logs before it name the reason. With `database_check_failed`, look for a blocking session (see [Database outage](#database-outage)). | Container test groups 4 and 10 |
| `app` restarts with exit code 2 and `s6-rc: fatal: timed out`, or with exit code 1 and `s6-rc: warning: unable to start service api: command exited 99` | The services did not all become ready within 120 s of the container starting, for example because a lock blocks the API's startup queries. Which line and code appear depends on which of two s6 timers fires first. | Container test group 11. Exit 2 with its line under both the earlier exit-2-only assertion and the current one; exit 1 with its line first in diagnostic runs under the earlier assertion (which failed on it), then in independent validation under the current one |
| Port 3105 in use | Set `APP_HOST_PORT` in `.env`. | Reproduced with another listener on `127.0.0.1:3105`: `ports are not available ... bind: address already in use`; `APP_HOST_PORT=3106` then started healthy |
| Compose warns `secret file ... does not exist`, or creating a container fails with `bind source path does not exist` | A secret file is missing. Check that `.secrets` holds all seven files (a `.secrets` directory created before the workbench lacks `better_auth_secret`: add it with `openssl rand -hex 32 > .secrets/better_auth_secret` rather than `--force`, which would replace the database passwords) and that `PA_SECRETS_DIR` points to it. | Reproduced by moving `worker_service_token` aside: a plain `up -d` with nothing to recreate did not notice, and `up -d --force-recreate app` failed with both messages |

## Image

| Item | Value |
| --- | --- |
| Base | `node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` (arm64 manifest `sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5`, amd64 `sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7`) |
| Database | `postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c` (arm64 `sha256:67ba68a22dc7d5af3627b7e0f33d10bbefad07562ff9703b3a6c2de247649129`, amd64 `sha256:9551dd5bf356409a21b31248f49b33bba9bb1877365f3a7e933aecd9af3cf52d`) |
| s6-overlay 3.2.3.2 | `noarch` `5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12`, `aarch64` `b17f17a82e7a515c682a91edaf2ffdabb73f891981b6c1fd712115693a2f8b4c`, `x86_64` `e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408`, verified by `ADD --checksum` and matching the release's `.sha256` files |
| pnpm | 12.14.0, installed in a build stage with the image's bundled npm (`npm install --global --prefix /opt/pnpm pnpm@12.14.0`); not in the runtime image |
| Size | 1.12 GB since the addition of the domain, connector and agent packages with their LangChain and Better Auth runtime dependencies; 485 MB before (`docker image ls`, Docker 29.8.2 with the containerd image store, linux/arm64) |

The runtime stage holds the Next standalone server with `.next/static` (the web
app has no `public` directory), the API and worker production dependencies, the
compiled packages, the packaged synthetic fixtures
(`packages/connectors/fixtures`) and recorded agent responses
(`packages/agents/recordings`), the SQL migrations and role provisioning SQL,
s6-overlay and the files under `docker/rootfs`. Evaluator oracles and
expectations (`evals/`) never enter the build context. npm, npx, corepack and yarn are removed. Labels:
`org.opencontainers.image.revision`, `.created`, `.title`, `.description` and
`.base.name`.

## Privileges

The whole container runs as `USER 10001:10001` (`app`), including s6-overlay;
no process starts as root and none needs `s6-setuidgid`. This works because
s6-overlay supports a non-root PID 1 when `/run` is a tmpfs owned by that user
with `exec`. Compose sets `read_only: true`, `cap_drop: [ALL]` and
`no-new-privileges:true` for `init` and `app`, and never mounts the Docker socket.
The container tests observed every process as uid 10001 with empty effective and
bounding capability sets and `NoNewPrivs: 1`.

Writable paths in `app`, all explicit: `/run` (tmpfs, uid 10001, `exec`, needed
by s6-overlay with `S6_READ_ONLY_ROOT=1`), `/tmp` (tmpfs, uid 10001, mode 0700)
and `/var/lib/app/evidence` (the `evidence` volume). Docker's own `/dev`,
`/dev/shm` and `/dev/mqueue` mounts stay writable as usual. Exceptions: `db`
runs the official PostgreSQL image unchanged; its entrypoint starts as root to
prepare the data directory and then runs the server as `postgres` (uid 999),
so it is not read-only or capability-dropped.

## Recorded verification

On 2026-10-21, on
macOS (darwin-arm64) with Docker Desktop: `scripts/demo/smoke.sh --project
prior-authorization-smoke-check --port 3127` passed (59 checks) with an image
built from the tested source: start without a model key, the full walkthrough
through the web BFF, stop and start of the whole deployment, `backup.sh`,
`down -v`, `restore.sh` into fresh volumes and completion of the restored
agent run that was waiting for review. Both projects and their volumes were
removed afterwards. This is offline workflow and recovery evidence for that
source.

Earlier evidence, on 2026-10-19 with
macOS (darwin-arm64), Docker 29.8.2, Compose v5.6.0:

- From a clean clone with no `node_modules`, the commands under [Start](#start)
  as written: healthy in 6 s with a warm BuildKit cache, and `GET /api/status`
  showed the build revision.
  Every response described under
  [Submit a synthetic probe](#submit-a-synthetic-probe) was observed with
  `curl`: 201 for a new probe, which the worker completed; 200 with
  `"replayed":true` for the same key and body; 409; 400 for a missing and for a
  short key; 400 for an extra field and for an empty label; and 413 for a
  17 kB body. `/favicon.ico` answered 200 `image/x-icon` and the page links it.
  The watchdog logged `"databaseAddress":"db:5432"`. `docker compose ps`,
  `docker compose logs app` and `init`, the `docker inspect` health query and
  both `curl` checks under [Logs and status](#logs-and-status) ran. Then
  `docker compose stop` (3 s, idle; the worker logged `worker stopped`),
  `docker compose down` (both volumes kept) and
  `docker compose -p prior-authorization down -v` (both volumes removed). Port
  3105 had no listener afterwards.
- `pnpm test:container` from a clean clone: 15 tests in 13 groups passed in
  506 s (see [development.md](development.md#container-tests)), after
  `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`,
  `test:integration`, `build` and `test:web` passed in the same clone. Group 11
  exited 2 in this run.
- Image size 485 MB (`docker image ls`).
- `scripts/init-secrets.sh` as committed, run by hand from another working
  directory: a relative `PA_SECRETS_DIR` was written under the repository root,
  an absolute one and a relative `--dir` as given, and the absolute directory
  was printed. An existing set was refused without `--force`. With a stand-in
  `od` that failed, and with one that returned 2 bytes, `--force` exited 1 with
  "could not read 32 random bytes from /dev/urandom", left all six existing
  files byte for byte unchanged and no temporary files; the earlier script, in
  the same failure, exited 0 and wrote an empty `postgres_password`. With the
  real `od`, `--force` replaced all six files with 64-character values.

Blocking-session queries and troubleshooting observations were recorded on
2026-10-18:

- From a clean clone with no `node_modules`: `cp .env.example .env`,
  `scripts/init-secrets.sh`, then `PA_BUILD_REVISION="$(git rev-parse HEAD)"
  docker compose up --build -d --wait` (healthy in 7 s with a warm BuildKit
  cache). Every command under [Logs and status](#logs-and-status) ran; a probe
  posted to `http://127.0.0.1:3105/api/pilot/probes` was completed by the worker,
  and `GET /api/status` showed the revision. The blocking-session queries under
  [Database outage](#database-outage) found the session holding a test lock. The
  troubleshooting rows marked as run were reproduced, then `docker compose stop`,
  `docker compose down`, and `docker compose -p prior-authorization down -v`
  (once after `down`, removing the two volumes, and once on a running stack,
  removing its three containers, two volumes and network). Port 3105 had no
  listener afterwards.
- `pnpm test:container` from a clean clone of the same revision: 15 tests in 13
  groups passed in 508 s (see [development.md](development.md#container-tests)).
- Image size 485 MB (`docker image ls`).

An earlier run recorded the idle stop time of 3.3 s.
