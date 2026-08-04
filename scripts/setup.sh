#!/usr/bin/env bash
# Bootstrap the local dev environment: Python venv with aiosendspin (for the
# E2E test server) and Node dependencies. Safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

AIOSENDSPIN_REF="9212f920e8fbaf9ad357b43835bd32cc386e73b8"

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install \
  "aiosendspin[server] @ git+https://github.com/Sendspin/aiosendspin.git@${AIOSENDSPIN_REF}"

yarn install --frozen-lockfile
