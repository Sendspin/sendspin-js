#!/usr/bin/env bash
# Bootstrap the local dev environment: Python venv with aiosendspin (for the
# E2E test server) and Node dependencies. Safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

# Temporary until aiosendspin cuts a release with pairing support.
AIOSENDSPIN_REF="main"

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
# Force the reinstall because pip skips an already-installed git URL at the same version.
.venv/bin/pip install --force-reinstall \
  "aiosendspin[server] @ git+https://github.com/Sendspin/aiosendspin.git@${AIOSENDSPIN_REF}"

yarn install --frozen-lockfile
