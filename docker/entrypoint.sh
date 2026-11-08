#!/bin/sh
# Installed as /usr/local/bin/cc-start.
#
#   cc-start all      migrations, then web and worker in one container (docker-prod)
#   cc-start web      migrations, then the web server alone
#   cc-start worker   the Temporal worker alone
#
# Binaries run from node_modules/.bin, never through pnpm: the image only has
# corepack's shim, which would download pnpm at start and cannot on a read-only
# root filesystem.
set -eu

usage() {
  echo "usage: cc-start [all|web|worker]" >&2
}

fail() {
  echo "cc-start: $*" >&2
  exit 1
}

mode="${1:-all}"
case "$mode" in
  all | web | worker) ;;
  *)
    usage
    exit 2
    ;;
esac

cd /app

TEMPORAL_BUILD_ID="$(cat /app/.build-id 2>/dev/null || echo dev)"
export TEMPORAL_BUILD_ID

# DATABASE_URL from its parts, so the password can arrive on its own from SSM.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DATABASE_PASSWORD:-}" ]; then
  for part in DATABASE_USER DATABASE_HOST DATABASE_NAME; do
    eval "value=\${$part:-}"
    [ -n "$value" ] || fail "DATABASE_PASSWORD is set but $part is not, so DATABASE_URL cannot be built"
  done
  # The password is read inside node, so it never appears on a command line.
  DATABASE_URL="$(node -e '
    const e = process.env;
    const enc = encodeURIComponent;
    process.stdout.write(
      `postgresql://${enc(e.DATABASE_USER)}:${enc(e.DATABASE_PASSWORD)}` +
        `@${e.DATABASE_HOST}:${e.DATABASE_PORT || "5432"}/${e.DATABASE_NAME}`
    );
  ')"
  export DATABASE_URL
fi

nl='
'

# seed_file FILE_VAR SEED_VAR [bare]: writes the seed to the file once. An
# existing file is never touched: the GMint SDK renews the certificate in place
# and the sequence counter must never go back.
seed_file() {
  eval "file=\${$1:-} content=\${$2:-}"
  [ -n "$file" ] && [ -n "$content" ] || return 0
  [ -e "$file" ] && return 0
  format='%s\n'
  case "$content" in *"$nl") format='%s' ;; esac
  [ "${3:-}" = bare ] && format='%s'
  tmp="$file.seed.$$"
  (umask 077 && mkdir -p "$(dirname "$file")" && printf "$format" "$content" >"$tmp")
  # ln refuses an existing target, so a container starting at the same moment
  # cannot replace a file another one already wrote and started using.
  if ! ln "$tmp" "$file" 2>/dev/null && [ ! -e "$file" ]; then
    rm -f "$tmp"
    fail "cannot write $file"
  fi
  rm -f "$tmp"
}

seed_file GMINT_SIGN_KEY_FILE GMINT_SIGN_KEY_SEED
seed_file GMINT_TLS_CERT_FILE GMINT_TLS_CERT_SEED
seed_file GMINT_TLS_KEY_FILE GMINT_TLS_KEY_SEED
seed_file GMINT_CA_FILE GMINT_CA_SEED
seed_file GMINT_SEQUENCE_FILE GMINT_SEQUENCE_SEED bare
unset GMINT_SIGN_KEY_SEED GMINT_TLS_CERT_SEED GMINT_TLS_KEY_SEED GMINT_CA_SEED GMINT_SEQUENCE_SEED

case "$mode" in
  all)
    node_modules/.bin/prisma migrate deploy
    # -k ties the two together: if either exits, the container exits, so a dead
    # worker can never leave the gate silently down. The port stays 3000:
    # compose passes the host's PORT into the container and maps it onto 3000.
    exec node_modules/.bin/concurrently -k -n web,worker \
      "node_modules/.bin/next start -H 0.0.0.0 -p 3000" \
      "node dist/worker.mjs"
    ;;
  web)
    node_modules/.bin/prisma migrate deploy
    exec node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
    ;;
  worker)
    exec node dist/worker.mjs
    ;;
esac
