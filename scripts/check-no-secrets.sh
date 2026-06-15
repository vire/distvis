#!/usr/bin/env bash
# Fail if a privileged secret appears in the deployable tree (R16).
# GitHub Pages uploads the repo root verbatim, so anything TRACKED ships
# publicly. Only the public anon JWT + PostgREST base URL (js/config.js) may.
#
# Conservative, false-positive-free patterns (these never appear as prose):
#   - a PEM private-key block (DB / JWT signing key material)
#   - a connection string carrying inline credentials (user:pass@host)
# Plus: no .env / .pgpass committed.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

secret_re='-----BEGIN [A-Z ]*PRIVATE KEY-----|://[^[:space:]:@/]+:[^[:space:]:@/]+@'
if matches=$(git ls-files -z | xargs -0 grep -nEI "$secret_re" 2>/dev/null) && [ -n "$matches" ]; then
  echo "ERROR: private key or credentialed connection string in a tracked file:" >&2
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
