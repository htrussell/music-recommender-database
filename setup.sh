#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKIP_DOWNLOAD=0
ASSUME_YES=0

usage() {
    cat <<'EOF'
Usage: bash ./setup.sh [--skip-download] [--yes]

Downloads the Kaggle CSVs, transforms them into the relational CSV tables,
starts PostgreSQL, and loads the tables.

Options:
  --skip-download  Reuse the raw CSVs already in csv/
  --yes            Skip the confirmation before replacing database tables
  -h, --help       Show this help
EOF
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

while (($#)); do
    case "$1" in
        --skip-download)
            SKIP_DOWNLOAD=1
            ;;
        --yes|-y)
            ASSUME_YES=1
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            fail "Unknown option: $1 (use --help for usage)"
            ;;
    esac
    shift
done

cd "$ROOT_DIR"

if command -v python3 >/dev/null 2>&1; then
    SYSTEM_PYTHON=python3
elif command -v python >/dev/null 2>&1; then
    SYSTEM_PYTHON=python
else
    fail "Python 3 is required. Install Python 3.10 or newer and rerun this script."
fi

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose)."

VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
"$SYSTEM_PYTHON" -m venv "$VENV_DIR"

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        VENV_BIN="$VENV_DIR/Scripts"
        VENV_PYTHON="$VENV_BIN/python.exe"
        ;;
    *)
        VENV_BIN="$VENV_DIR/bin"
        VENV_PYTHON="$VENV_BIN/python"
        ;;
esac

[[ -x "$VENV_PYTHON" ]] || fail "Could not find the virtual-environment Python at $VENV_PYTHON."
export PATH="$VENV_BIN:$PATH"

printf '%s\n' "Installing Kaggle CLI and CSV transformation dependency..."
"$VENV_PYTHON" -m pip install --upgrade pip pandas kaggle

if ((SKIP_DOWNLOAD)); then
    for source in dataset.csv album_ratings.csv artists.csv; do
        [[ -f "$ROOT_DIR/csv/$source" ]] ||
            fail "Missing csv/$source; remove --skip-download or add the source CSV."
    done
    printf '%s\n' "Reusing raw CSV files in csv/."
else
    if [[ -z "${KAGGLE_USERNAME:-}" || -z "${KAGGLE_KEY:-}" ]]; then
        KAGGLE_CONFIG_DIR="${KAGGLE_CONFIG_DIR:-$HOME/.kaggle}"
        [[ -f "$KAGGLE_CONFIG_DIR/kaggle.json" ]] ||
            fail "Kaggle credentials are missing. Set KAGGLE_USERNAME and KAGGLE_KEY, or configure $KAGGLE_CONFIG_DIR/kaggle.json."
    fi

    printf '%s\n' "Downloading the four Kaggle source datasets into csv/..."
    (cd "$ROOT_DIR/csv" && "$VENV_PYTHON" download-kaggle.py)
fi

printf '%s\n' "Transforming source CSVs into the eight relational tables..."
"$VENV_PYTHON" "$ROOT_DIR/transform_erd.py"

for table in genre artists album tracks album_scores track_feel track_artists artist_genres; do
    [[ -s "$ROOT_DIR/transformed/$table.csv" ]] ||
        fail "Transformation did not produce transformed/$table.csv."
done

if ((!ASSUME_YES)); then
    if [[ ! -t 0 ]]; then
        fail "Loading replaces the existing music tables. Rerun with --yes to confirm."
    fi
    printf '%s\n' "The loader drops and recreates the music tables in track-db."
    read -r -p "Continue with the database load? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || {
        printf '%s\n' "Database load cancelled."
        exit 1
    }
fi

printf '%s\n' "Starting PostgreSQL..."
docker compose up -d postgres

printf '%s\n' "Loading transformed CSVs into PostgreSQL..."
docker compose run --build --rm data-loader

printf '%s\n' "Setup complete. PostgreSQL is available on localhost:5432."
