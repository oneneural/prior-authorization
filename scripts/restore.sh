#!/bin/sh
# Restores a scripts/backup.sh directory into a Compose project that has no
# volumes yet (fresh-volume restore only; it never overwrites a deployment).
#
# Usage: scripts/restore.sh [--project NAME] --from DIR
#   --project NAME  target Compose project (default: $COMPOSE_PROJECT_NAME or prior-authorization)
#   --from DIR      backup directory with db.dump, evidence.tar and MANIFEST
#
# Use the secrets directory (PA_SECRETS_DIR) of the backed-up deployment, or
# fresh secrets from scripts/init-secrets.sh: role passwords live in the secret
# files, not in the dump. Steps: verify the manifest hashes, start PostgreSQL on
# new volumes, provision roles and the database, restore the dump, unpack the
# evidence, then start the whole deployment (init applies any pending
# migrations; the API's idempotent seed leaves restored cases untouched).
# A restore never touches the live accounting ledger, so restoring an older
# database cannot return spent budget; replayed attempts are refused by it.
#
# A restore that fails part way leaves the target's new volumes behind, and a
# rerun refuses them. Remove the failed target with
# `docker compose -p <target> down -v` before retrying, never against the live
# project; the script prints that command when it fails after creating volumes.
set -eu

project="${COMPOSE_PROJECT_NAME:-prior-authorization}"
from=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || { echo "restore: --project needs a value" >&2; exit 2; }; project="$2"; shift 2 ;;
    --from) [ "$#" -ge 2 ] || { echo "restore: --from needs a value" >&2; exit 2; }; from="$2"; shift 2 ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "restore: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$from" ] || { echo "restore: --from DIR is required" >&2; exit 2; }
from="$(cd "$from" && pwd)"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
for name in db.dump evidence.tar; do
  expected="$(sed -n "s/^$name=//p" "$from/MANIFEST")"
  if [ -z "$expected" ] || [ "$(sha "$from/$name")" != "$expected" ]; then
    echo "restore: $name does not match MANIFEST" >&2
    exit 1
  fi
done

# A plain assignment so a failing docker call aborts under set -e instead of
# reading as an empty (fresh) project.
volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
if [ -n "$volumes" ]; then
  echo "restore: project $project already has volumes; restore only into a fresh project" >&2
  exit 1
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
compose() { docker compose --project-directory "$repo" -p "$project" "$@"; }

# Armed only after the fresh-project check, so it never names a live project.
on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "restore: failed; project $project may hold partial volumes. Remove it before retrying (never the live project):" >&2
    echo "restore:   ${PA_SECRETS_DIR:+PA_SECRETS_DIR=$PA_SECRETS_DIR }docker compose -p $project down -v" >&2
  fi
}
trap on_exit EXIT

compose up -d --wait db
compose run --rm --no-deps --entrypoint /usr/local/bin/node init /app/packages/db/dist/bin/provision.js
compose exec -T db pg_restore -U postgres -d prior_authorization --exit-on-error < "$from/db.dump"
compose run --rm -T --no-deps --entrypoint tar app -xf - -C /var/lib/app/evidence < "$from/evidence.tar"
compose up -d --wait

echo "restore: project $project restored from $from"
