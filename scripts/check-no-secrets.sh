#!/usr/bin/env bash
# Fail if a privileged secret appears in the deployable tree (R16).
# GitHub Pages uploads the repo root verbatim, so anything TRACKED ships
# publicly. Only the public anon JWT + PostgREST base URL (js/config.js) may.
#
# Conservative, false-positive-free patterns (these never appear as prose):
#   - a PEM private-key block (DB / JWT signing key material)
#   - a connection string carrying inline credentials (user:pass@host)
#   - a PGPASSWORD env assignment or a libpq passwd keyword carrying a value
# Plus: no .env / .pgpass committed.
# Note: the PostgREST anon JWT (eyJ...) is public by design and is NOT flagged.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

secret_re='-----BEGIN [A-Z ]*PRIVATE KEY-----|://[^[:space:]:@/]+:[^[:space:]:@/]+@|(PGPASSWORD|password)=[^[:space:]<]'
# Exclude this guard script itself (its patterns would self-match) via a git
# pathspec, not grep -z (BSD grep mishandles -zv). Capture independently of the
# pipeline exit status: xargs/grep exit non-zero when a batch has no match,
# which must NOT be read as "guard passed".
# -e is required: the pattern starts with "-----", which grep would otherwise
# parse as option flags.
matches=$(git ls-files -z -- ':(exclude)scripts/check-no-secrets.sh' \
          | xargs -0 grep -nEI -e "$secret_re" 2>/dev/null || true)
if [ -n "$matches" ]; then
  echo "ERROR: private key, credentialed connection string, or password in a tracked file:" >&2
  echo "$matches" >&2
  fail=1
fi

if secrets=$(git ls-files | grep -E '(^|/)\.env($|\.)|(^|/)\.pgpass$' || true); [ -n "$secrets" ]; then
  echo "ERROR: secret file(s) tracked in git (must be gitignored):" >&2
  echo "$secrets" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "Move secrets out of the repo — only the PUBLIC anon JWT + base URL may ship." >&2
  exit 1
fi
echo "secret guard: clean"
