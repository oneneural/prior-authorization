#!/bin/sh
# Backs up one Compose deployment: the prior_authorization database (pg_dump
# custom format, which includes case revisions, source blobs, packets, requests,
# receipts, sessions, the queue and agent checkpoints) plus the evidence volume.
#
# Usage: scripts/backup.sh [--project NAME] --out DIR
#   --project NAME  Compose project (default: $COMPOSE_PROJECT_NAME or prior-authorization)
#   --out DIR       new or empty directory for db.dump, evidence.tar and MANIFEST
#
# The app service is stopped during the backup so the database and evidence
# copies form one consistent pair, then started again if it was running. Run it
# from the repository root with the same environment (.env, PA_IMAGE_TAG,
# PA_SECRETS_DIR) used to start the deployment. The output holds synthetic case
# data; keep it local and delete it when no longer needed (docs/operations.md).
# The live accounting ledger is deliberately not part of a backup: it lives
# outside the project's volumes and is managed only by its maintenance command.
set -eu

project="${COMPOSE_PROJECT_NAME:-prior-authorization}"
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || { echo "backup: --project needs a value" >&2; exit 2; }; project="$2"; shift 2 ;;
    --out) [ "$#" -ge 2 ] || { echo "backup: --out needs a value" >&2; exit 2; }; out="$2"; shift 2 ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "backup: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || { echo "backup: --out DIR is required" >&2; exit 2; }
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "backup: $out is not empty" >&2
  exit 1
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
compose() { docker compose --project-directory "$repo" -p "$project" "$@"; }

if [ -z "$(compose ps -q db)" ]; then
  echo "backup: project $project has no running db service" >&2
  exit 1
fi

umask 077
mkdir -p "$out"
out="$(cd "$out" && pwd)"

running="$(compose ps -q --status running app)"
if [ -n "$running" ]; then
  echo "backup: stopping app for a consistent copy"
  compose stop app >/dev/null
fi
restart_app() {
  if [ -n "$running" ]; then
    compose start app >/dev/null
  fi
}
trap restart_app EXIT

# The Unix socket inside the db container is the only trusted connection, so no
# credential is read or printed here.
compose exec -T db pg_dump -U postgres -d prior_authorization -Fc > "$out/db.dump"
# The app image's tar, as the app user, through stdout: no host bind mount.
compose run --rm -T --no-deps --entrypoint tar app -cf - -C /var/lib/app/evidence . > "$out/evidence.tar"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
{
  echo "project=$project"
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "revision=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "db.dump=$(sha "$out/db.dump")"
  echo "evidence.tar=$(sha "$out/evidence.tar")"
} > "$out/MANIFEST"

echo "backup: wrote $out (db.dump $(wc -c < "$out/db.dump" | tr -d ' ') bytes, evidence.tar $(wc -c < "$out/evidence.tar" | tr -d ' ') bytes)"
