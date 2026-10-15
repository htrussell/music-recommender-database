#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_URL="${WEB_URL:-http://localhost:8080}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-900}"

cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || {
    printf '%s\n' "Docker is required. Install Docker Desktop or Docker Engine and try again." >&2
    exit 1
}

docker compose version >/dev/null 2>&1 || {
    printf '%s\n' "Docker Compose v2 is required (the 'docker compose' command)." >&2
    exit 1
}

command -v curl >/dev/null 2>&1 || {
    printf '%s\n' "curl is required to check when the web UI is ready." >&2
    exit 1
}

docker info >/dev/null 2>&1 || {
    printf '%s\n' "Docker is installed but its engine is not running. Start Docker Desktop/Engine and retry." >&2
    exit 1
}

printf '%s\n' "Building and starting the web UI, Cloudflare-backed AI API, local embedding model, and database service..."
docker compose up --build --detach frontend ai-api ollama

printf 'Waiting up to %s seconds for the embedding model download and web UI at %s ...\n' "$STARTUP_TIMEOUT_SECONDS" "$WEB_URL"
ready=0
for ((second = 0; second < STARTUP_TIMEOUT_SECONDS; second += 2)); do
    if curl --silent --fail --output /dev/null "$WEB_URL"; then
        ready=1
        break
    fi
    sleep 2
done

if (( ! ready )); then
    printf '%s\n' "The web UI did not respond before the timeout. Containers are still running; inspect them with 'docker compose ps' and 'docker compose logs frontend ai-api'." >&2
    exit 1
fi

printf 'Web UI is ready: %s\n' "$WEB_URL"
case "$(uname -s)" in
    Darwin*)
        open "$WEB_URL" || python3 -c 'import sys, webbrowser; sys.exit(0 if webbrowser.open(sys.argv[1]) else 1)' "$WEB_URL"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        cmd.exe /c start "" "$WEB_URL" || python -c 'import sys, webbrowser; sys.exit(0 if webbrowser.open(sys.argv[1]) else 1)' "$WEB_URL"
        ;;
    Linux*)
        if [[ -n "${WSL_DISTRO_NAME:-}" ]] && command -v cmd.exe >/dev/null 2>&1; then
            cmd.exe /c start "" "$WEB_URL" || python3 -c 'import sys, webbrowser; sys.exit(0 if webbrowser.open(sys.argv[1]) else 1)' "$WEB_URL"
        elif command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$WEB_URL" >/dev/null 2>&1 || python3 -c 'import sys, webbrowser; sys.exit(0 if webbrowser.open(sys.argv[1]) else 1)' "$WEB_URL"
        else
            python3 -c 'import sys, webbrowser; sys.exit(0 if webbrowser.open(sys.argv[1]) else 1)' "$WEB_URL" || printf 'Could not open a browser automatically. Visit %s\n' "$WEB_URL"
        fi
        ;;
    *)
        python3 -c 'import sys, webbrowser; sys.exit(0 if webbrowser.open(sys.argv[1]) else 1)' "$WEB_URL" || printf 'Could not open a browser automatically. Visit %s\n' "$WEB_URL"
        ;;
esac
