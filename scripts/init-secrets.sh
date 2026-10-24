#!/bin/sh
# Creates the local secret files read by compose.yaml: random passwords for the
# PostgreSQL bootstrap superuser and the three application roles, the role
# connection URLs built from them, and the worker service token.
#
# Usage: scripts/init-secrets.sh [--dir DIR] [--force]
#   --dir DIR  target directory, relative to the current directory (default:
#              $PA_SECRETS_DIR, or .secrets; a relative PA_SECRETS_DIR is taken
#              from the repository root, as compose.yaml resolves it)
#   --force    replace existing files. PostgreSQL applies its bootstrap password
#              only when the volume is first initialised, so replacing secrets
#              for an existing deployment also needs the reset in
#              docs/operations.md.
#
# The directory is created with mode 0700 so other host users cannot read it.
# Files are 0644 inside it: Compose bind-mounts file secrets with their host
# owner and mode (it does not apply uid or mode outside Swarm), and the database
# (uid 999) and application (uid 10001) containers must be able to read them.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
dir="${PA_SECRETS_DIR:-.secrets}"
case "$dir" in
  /*) ;;
  *) dir="$repo/$dir" ;;
esac
force=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || { echo "init-secrets: --dir needs a value" >&2; exit 2; }
      dir="$2"
      shift 2
      ;;
    --force)
      force=true
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "init-secrets: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

files="postgres_password database_url_admin database_url_migrator database_url_api database_url_worker worker_service_token better_auth_secret"

if [ "$force" = false ]; then
  existing=""
  for name in $files; do
    if [ -e "$dir/$name" ]; then
      existing="$existing $name"
    fi
  done
  if [ -n "$existing" ]; then
    echo "init-secrets: refusing to overwrite existing secrets in $dir:$existing" >&2
    echo "init-secrets: keep them, or rerun with --force (see docs/operations.md before replacing)" >&2
    exit 1
  fi
fi

# 32 random bytes as 64 hexadecimal characters: safe inside a URL without encoding.
# A pipeline's status is its last command's, so a failed read is caught by the
# length check; each value is assigned on its own line, so under set -e the
# script stops before any file is replaced.
random_hex() {
  value="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  if [ "${#value}" -ne 64 ]; then
    echo "init-secrets: could not read 32 random bytes from /dev/urandom" >&2
    exit 1
  fi
  printf '%s' "$value"
}

umask 077
mkdir -p "$dir"
chmod 0700 "$dir"
dir="$(cd "$dir" && pwd)"

# Every file is written to a temporary name first and moved into place only
# when all of them exist, so a failure while generating or writing them leaves
# the existing files untouched. The final moves are not atomic as a set: a move
# failing part way (with --force, a mix of old and new files) needs a rerun.
stage() {
  printf '%s' "$2" > "$dir/.$1.tmp"
  chmod 0644 "$dir/.$1.tmp"
}
cleanup() {
  for name in $files; do
    rm -f "$dir/.$name.tmp"
  done
}
trap cleanup EXIT

postgres_password="$(random_hex)"
migrator_password="$(random_hex)"
api_password="$(random_hex)"
worker_password="$(random_hex)"
worker_service_token="$(random_hex)"
better_auth_secret="$(random_hex)"

# Host and database are fixed by compose.yaml: service `db`, database prior_authorization.
stage postgres_password "$postgres_password"
stage database_url_admin "postgres://postgres:$postgres_password@db:5432/postgres"
stage database_url_migrator "postgres://pa_migrator:$migrator_password@db:5432/prior_authorization"
stage database_url_api "postgres://pa_api:$api_password@db:5432/prior_authorization"
stage database_url_worker "postgres://pa_worker:$worker_password@db:5432/prior_authorization"
stage worker_service_token "$worker_service_token"
stage better_auth_secret "$better_auth_secret"
for name in $files; do
  mv "$dir/.$name.tmp" "$dir/$name"
done

echo "init-secrets: wrote $(echo $files | wc -w | tr -d ' ') secret files to $dir"
