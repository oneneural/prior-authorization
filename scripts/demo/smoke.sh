#!/bin/sh
# End-to-end smoke of the packaged offline demo against a disposable Compose
# deployment, then a fresh-volume restore. It never touches another project.
#
# Usage: scripts/demo/smoke.sh [--project NAME] [--port PORT] [--no-build] [--keep]
#   --project NAME  disposable Compose project (default prior-authorization-smoke);
#                   the restore uses NAME-restore. Both must not exist yet.
#   --port PORT     free loopback port for the web UI (default 3105)
#   --no-build      reuse prior-authorization-app:$PA_IMAGE_TAG (default tag smoke)
#   --keep          leave the restored deployment running for inspection
#
# Steps: generate throwaway secrets, start with no model key and recorded runs
# selected, drive the walkthrough (scripts/demo/walkthrough.mjs), stop and start
# the deployment and verify, back up the database and evidence, remove the
# deployment with its volumes, restore into fresh volumes, verify again and
# complete the pending recorded run, then remove everything (down -v).
set -eu

project=prior-authorization-smoke
port=3105
build=true
keep=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || { echo "smoke: --project needs a value" >&2; exit 2; }; project="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] || { echo "smoke: --port needs a value" >&2; exit 2; }; port="$2"; shift 2 ;;
    --no-build) build=false; shift ;;
    --keep) keep=true; shift ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "smoke: unknown argument $1" >&2; exit 2 ;;
  esac
done
restored="$project-restore"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"

for name in "$project" "$restored"; do
  if docker compose ls -a --format json | grep -q "\"Name\":\"$name\"" || [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$name")" ]; then
    echo "smoke: Compose project $name or its volumes already exist; choose another --project" >&2
    exit 1
  fi
done
if nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "smoke: 127.0.0.1:$port is in use; choose another --port" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/pa-smoke.XXXXXX")"
# No model key or external tracing reaches Compose, and live mode stays at zero budgets.
unset ANTHROPIC_API_KEY LANGSMITH_API_KEY LANGSMITH_TRACING LANGSMITH_TRACING_V2 LANGCHAIN_TRACING LANGCHAIN_TRACING_V2 AGENT_RUN_BUDGET_USD AGENT_DAILY_BUDGET_USD AGENT_TOTAL_BUDGET_USD PA_ACCOUNTING_DIR PA_ANTHROPIC_API_KEY_HOST_FILE 2>/dev/null || true
export PA_SECRETS_DIR="$work/secrets" APP_HOST_PORT="$port" PA_PUBLIC_ORIGIN="http://127.0.0.1:$port"
export AGENT_GRAPH_PROVIDER=recorded PA_IMAGE_TAG="${PA_IMAGE_TAG:-smoke}" PA_DEMO_ORIGIN="http://127.0.0.1:$port"
PA_BUILD_REVISION="$(git rev-parse HEAD)"
export PA_BUILD_REVISION

cleanup() {
  status=$?
  if [ "$keep" = true ] && [ "$status" -eq 0 ]; then
    echo "smoke: kept $restored on $PA_DEMO_ORIGIN; remove it with: PA_SECRETS_DIR=$PA_SECRETS_DIR docker compose -p $restored down -v"
  else
    docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
    docker compose -p "$restored" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

step() { printf '\n== %s\n' "$1"; }

step "secrets and image (revision $PA_BUILD_REVISION)"
scripts/init-secrets.sh --dir "$PA_SECRETS_DIR"
if [ "$build" = true ]; then
  docker compose -p "$project" build app
fi

step "start $project on $PA_DEMO_ORIGIN with no model key"
docker compose -p "$project" up -d --wait
app="$(docker compose -p "$project" ps -q app)"
if docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$app" | grep -Eq '^(ANTHROPIC|LANGSMITH|LANGCHAIN)_'; then
  echo "smoke: the app container received a model key or tracing variable" >&2
  exit 1
fi
echo "ok - the app container holds no ANTHROPIC, LANGSMITH or LANGCHAIN variable"
# shellcheck disable=SC2016 # the backticks are a JavaScript template literal
curl -fsS "$PA_DEMO_ORIGIN/api/status" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log(`ok - status: revision ${j.build.revision}, modes ${JSON.stringify(j.modes)}`)})'

step "walkthrough"
node scripts/demo/walkthrough.mjs drive "$work/state.json"

step "stop and start the whole deployment"
docker compose -p "$project" stop
docker compose -p "$project" up -d --wait
node scripts/demo/walkthrough.mjs verify "$work/state.json"

step "backup database and evidence"
scripts/backup.sh --project "$project" --out "$work/backup"
cat "$work/backup/MANIFEST"
docker compose -p "$project" down -v
echo "ok - $project and its volumes removed"

step "restore into fresh volumes as $restored"
scripts/restore.sh --project "$restored" --from "$work/backup"
node scripts/demo/walkthrough.mjs verify "$work/state.json" --complete-pending

step "result"
echo "smoke: PASSED for revision $PA_BUILD_REVISION at $PA_DEMO_ORIGIN (projects $project and $restored)"
