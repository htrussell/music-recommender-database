#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
elif command -v python >/dev/null 2>&1; then
    PYTHON=python
else
    printf 'Python 3.10 or newer is required.\n' >&2
    exit 1
fi

exec "$PYTHON" "$ROOT_DIR/setup.py" "$@"
