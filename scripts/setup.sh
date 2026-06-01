#!/usr/bin/env bash
# Bootstrap the local dev environment: Python venv with aiosendspin (for the
# E2E test server) and Node dependencies. Safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install "aiosendspin[server]>=6.0,<7"

yarn install --frozen-lockfile
