#!/usr/bin/env python3
"""Cross-platform interactive setup for the music recommender demo."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser


ROOT_DIR = Path(__file__).resolve().parent
VENV_DIR = ROOT_DIR / ".venv"
SOURCE_FILES = (
    "dataset.csv",
    "artists.csv",
    "album_ratings.csv",
    "music_streaming_habits_2026.csv",
)
PARQUET_TABLES = (
    "genre",
    "artists",
    "album",
    "tracks",
    "album_scores",
    "track_feel",
    "track_artists",
    "artist_genres",
)


class SetupError(RuntimeError):
    pass


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=cwd or ROOT_DIR, env=env, check=True)


def prompt_choice(prompt: str, choices: tuple[str, ...], default: str) -> str:
    choice_text = "/".join(choices)
    while True:
        answer = input(f"{prompt} [{choice_text}] (default: {default}): ").strip().lower()
        if not answer:
            return default
        if answer in choices:
            return answer
        print(f"Please enter one of: {', '.join(choices)}")


def prompt_yes_no(prompt: str, default: bool = False) -> bool:
    default_text = "Y/n" if default else "y/N"
    while True:
        answer = input(f"{prompt} [{default_text}]: ").strip().lower()
        if not answer:
            return default
        if answer in {"y", "yes"}:
            return True
        if answer in {"n", "no"}:
            return False
        print("Please enter y or n.")


def docker_available() -> bool:
    if shutil.which("docker") is None:
        raise SetupError("Docker is required. Install Docker Desktop or Docker Engine and retry.")
    try:
        run(["docker", "compose", "version"])
        run(["docker", "info"])
    except subprocess.CalledProcessError as error:
        raise SetupError("Docker Compose or the Docker engine is unavailable.") from error


def venv_python() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def create_venv() -> Path:
    print("Creating or updating the Python virtual environment...")
    subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], cwd=ROOT_DIR, check=True)
    python = venv_python()
    if not python.is_file():
        raise SetupError(f"Could not find virtual environment Python at {python}.")
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])
    run([
        str(python),
        "-m",
        "pip",
        "install",
        "pandas",
        "pyarrow",
        "kaggle",
        "psycopg2-binary",
    ])
    return python


def kaggle_credentials_exist() -> bool:
    if os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY"):
        return True
    credentials = Path(os.environ.get("KAGGLE_CONFIG_DIR", Path.home() / ".kaggle")) / "kaggle.json"
    return credentials.is_file()


def write_kaggle_credentials(username: str, key: str) -> Path:
    config_dir = Path(os.environ.get("KAGGLE_CONFIG_DIR", Path.home() / ".kaggle"))
    config_dir.mkdir(parents=True, exist_ok=True)
    credentials = config_dir / "kaggle.json"
    credentials.write_text(
        json.dumps({"username": username, "key": key}, ensure_ascii=False),
        encoding="utf-8",
    )
    try:
        os.chmod(credentials, 0o600)
    except (AttributeError, OSError):
        pass
    if os.name == "nt":
        username = os.environ.get("USERNAME")
        if username:
            try:
                run([
                    "icacls",
                    str(credentials),
                    "/inheritance:r",
                    "/grant:r",
                    f"{username}:(R,W)",
                ])
            except (SetupError, subprocess.CalledProcessError):
                print("Warning: could not explicitly restrict the Kaggle credential file ACL.")
    print(f"Kaggle credentials saved to {credentials}.")
    return credentials


def configure_kaggle_credentials(python: Path) -> None:
    if os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY"):
        print("Kaggle credentials found in environment variables.")
        return
    if kaggle_credentials_exist():
        print("Existing Kaggle credentials found.")
        return

    username = os.environ.get("KAGGLE_USERNAME") or input("Kaggle username: ").strip()
    if not username:
        raise SetupError("A Kaggle username is required.")
    key = getpass.getpass("Kaggle API key (input hidden): ").strip()
    if not key:
        raise SetupError("A Kaggle API key is required.")
    write_kaggle_credentials(username, key)


def configure_youtube_api_key(non_interactive: bool) -> None:
    if non_interactive:
        return
    if os.environ.get("YOUTUBE_API_KEY"):
        print("YouTube API key found in the environment.")
        return
    if not prompt_yes_no("Configure an optional YouTube API key?", default=False):
        return

    print("Create a key: https://console.cloud.google.com/apis/credentials")
    key = getpass.getpass("YouTube API key (input hidden): ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", key):
        raise SetupError("The YouTube API key must be non-empty and contain only letters, digits, underscores, or hyphens.")

    env_file = ROOT_DIR / ".env"
    try:
        if env_file.exists():
            contents = env_file.read_text(encoding="utf-8")
            lines = contents.splitlines(keepends=True)
            lines = [
                line for line in lines
                if not re.match(r"^\s*(?:export\s+)?YOUTUBE_API_KEY\s*=", line)
            ]
            contents = "".join(lines)
            if contents and not contents.endswith(("\n", "\r")):
                contents += "\n"
            env_file.write_text(contents + f"YOUTUBE_API_KEY={key}\n", encoding="utf-8")
        else:
            fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                file.write(f"YOUTUBE_API_KEY={key}\n")
    except OSError as error:
        raise SetupError(f"Could not save the YouTube API key to {env_file}.") from error
    print(f"YouTube API key saved to {env_file}.")


def source_choice(args: argparse.Namespace) -> str:
    if args.download == "download":
        return "download"
    if args.download == "reuse-csv":
        return "reuse-csv"
    if args.download == "reuse-parquet":
        return "reuse-parquet"
    return prompt_choice(
        "Choose source data handling",
        ("download", "reuse-csv", "reuse-parquet"),
        "reuse-csv",
    )


def require_source_csvs() -> None:
    missing = [name for name in SOURCE_FILES if not (ROOT_DIR / "csv" / name).is_file()]
    if missing:
        raise SetupError(
            "Missing source CSV files: "
            + ", ".join(missing)
            + ". Download them or reuse transformed Parquet files."
        )


def download_catalog(python: Path) -> None:
    configure_kaggle_credentials(python)
    print("Downloading Kaggle datasets...")
    run([str(python), "download-kaggle.py"], cwd=ROOT_DIR / "csv")


def transform_catalog(python: Path) -> None:
    print("Transforming source CSVs into canonical Parquet tables...")
    run([str(python), str(ROOT_DIR / "transform_erd.py")])
    missing = [
        table
        for table in PARQUET_TABLES
        if not (ROOT_DIR / "transformed" / f"{table}.parquet").is_file()
    ]
    if missing:
        raise SetupError("Transformation did not produce: " + ", ".join(missing))


def load_postgres(args: argparse.Namespace) -> bool:
    if args.skip_postgres_load:
        print("Skipping PostgreSQL catalog load.")
        return False
    if args.yes:
        proceed = True
    elif args.non_interactive:
        proceed = True
    else:
        proceed = prompt_yes_no(
            "Load the catalog into PostgreSQL? This replaces existing music tables.",
            default=True,
        )
    if not proceed:
        print("Skipping PostgreSQL catalog load.")
        return False

    print("Starting PostgreSQL...")
    run(["docker", "compose", "up", "-d", "postgres"])
    try:
        run([
            "docker",
            "compose",
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "airflow",
            "-d",
            "track-db",
            "-c",
            'ALTER DATABASE "track-db" REFRESH COLLATION VERSION;',
        ])
    except subprocess.CalledProcessError:
        pass

    print("Loading Parquet tables into PostgreSQL...")
    run(["docker", "compose", "run", "--build", "--rm", "-T", "data-loader"])
    return True


def wait_for_embedding_model(timeout_seconds: int = 120) -> None:
    print("Waiting for the Nomic embedding model...")
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        result = subprocess.run(
            [
                "docker",
                "compose",
                "exec",
                "-T",
                "ollama",
                "ollama",
                "show",
                "nomic-embed-text:v1.5",
            ],
            cwd=ROOT_DIR,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            print("Nomic embedding model is ready.")
            return
        time.sleep(2)
    raise SetupError("Timed out waiting for the Nomic embedding model.")


def build_embeddings(mode: str, limit: int | None) -> None:
    if mode == "none":
        print("Skipping pgvector embedding build.")
        return
    print("Starting Ollama...")
    run(["docker", "compose", "up", "-d", "ollama", "ollama-model"])
    wait_for_embedding_model()
    env = os.environ.copy()
    env["OLLAMA_EMBEDDING_MODEL"] = "nomic-embed-text:v1.5"
    env["OLLAMA_URL"] = "http://ollama:11434"
    env["CATALOG_SNAPSHOT_ID"] = "current"
    if mode == "subset":
        env["EMBEDDING_MAX_TRACKS"] = str(limit or 32)
    else:
        env.pop("EMBEDDING_MAX_TRACKS", None)

    print("Building catalog embeddings...")
    run(
        [
            "docker",
            "compose",
            "run",
            "--build",
            "--rm",
            "-T",
            "-e",
            "OLLAMA_URL=http://ollama:11434",
            "-e",
            "OLLAMA_EMBEDDING_MODEL=nomic-embed-text:v1.5",
            "-e",
            "CATALOG_SNAPSHOT_ID=current",
        ]
        + (
            ["-e", f"EMBEDDING_MAX_TRACKS={limit or 32}"]
            if mode == "subset"
            else []
        )
        + ["data-loader", "python", "embed_catalog.py"],
        env=env,
    )


def semantic_choice(args: argparse.Namespace) -> tuple[str, int | None]:
    if args.semantic:
        if args.semantic == "subset":
            return "subset", args.embedding_limit or 32
        return args.semantic, None
    mode = prompt_choice(
        "Choose semantic pgvector retrieval",
        ("none", "subset", "full"),
        "none",
    )
    if mode != "subset":
        return mode, None
    while True:
        answer = input("Number of tracks to embed (default: 32): ").strip()
        if not answer:
            return "subset", 32
        try:
            limit = int(answer)
            if limit > 0:
                return "subset", limit
        except ValueError:
            pass
        print("Please enter a positive integer.")


def start_demo(include_embeddings: bool = False) -> None:
    print("Starting the demo...")
    services = ["frontend", "ai-api"]
    if include_embeddings:
        services.extend(["ollama", "ollama-model"])
    run(["docker", "compose", "up", "--build", "--detach", *services])
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://localhost:8080", timeout=5):
                print("Web UI is ready: http://localhost:8080")
                webbrowser.open("http://localhost:8080")
                return
        except Exception:
            time.sleep(2)
    raise SetupError("The web UI did not become ready before the timeout.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Interactive music recommender setup")
    parser.add_argument("--download", choices=("download", "reuse-csv", "reuse-parquet"), help="Choose source data handling.")
    parser.add_argument("--skip-download", action="store_true", help="Reuse existing CSV files.")
    parser.add_argument("--skip-postgres-load", action="store_true", help="Do not load PostgreSQL.")
    parser.add_argument("--semantic", choices=("none", "subset", "full"), help="Choose pgvector build mode.")
    parser.add_argument("--embedding-limit", type=int, help="Number of tracks for a subset embedding build.")
    parser.add_argument("--yes", action="store_true", help="Skip destructive-load confirmation.")
    parser.add_argument("--start", action="store_true", help="Start the demo after setup.")
    parser.add_argument("--non-interactive", action="store_true", help="Use defaults and avoid prompts.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        docker_available()
        configure_youtube_api_key(args.non_interactive)
        python = create_venv()

        if args.skip_download:
            args.download = "reuse-csv"
        source = source_choice(args)
        if source == "download":
            download_catalog(python)
        elif source == "reuse-csv":
            require_source_csvs()
        elif source == "reuse-parquet":
            missing = [
                table
                for table in PARQUET_TABLES
                if not (ROOT_DIR / "transformed" / f"{table}.parquet").is_file()
            ]
            if missing:
                raise SetupError("Missing transformed Parquet tables: " + ", ".join(missing))

        if source != "reuse-parquet":
            transform_catalog(python)

        load_postgres(args)
        semantic_mode, embedding_limit = semantic_choice(args)
        build_embeddings(semantic_mode, embedding_limit)

        if args.start or (
            not args.non_interactive
            and prompt_yes_no("Start the demo now?", default=True)
        ):
            start_demo(include_embeddings=semantic_mode != "none")
        print("Setup complete.")
        return 0
    except (SetupError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        print(f"Setup failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
