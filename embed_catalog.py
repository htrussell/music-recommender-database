import hashlib
import os
import sys
import time
from pathlib import Path

import duckdb
import httpx
import psycopg2
from psycopg2.extras import execute_values


DB_PARAMS = {
    "dbname": "track-db",
    "user": "airflow",
    "password": "airflow",
    "host": "postgres",
    "port": "5432",
}
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434").rstrip("/")
EMBEDDING_MODEL = os.getenv("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text:v1.5")
SNAPSHOT_ID = os.getenv("CATALOG_SNAPSHOT_ID", "current")
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "32"))
MAX_TRACKS = int(os.getenv("EMBEDDING_MAX_TRACKS", "0"))


def catalog_text(row: tuple) -> str:
    track_id, title, artist, genre, energy, valence, danceability, acousticness, instrumentalness, tempo = row
    values = [
        f"Track: {title}",
        f"Artist: {artist}",
        f"Genre: {genre or 'unknown'}",
    ]
    if energy is not None:
        values.append(f"Energy: {float(energy):.3f}")
    if valence is not None:
        values.append(f"Valence: {float(valence):.3f}")
    if danceability is not None:
        values.append(f"Danceability: {float(danceability):.3f}")
    if acousticness is not None:
        values.append(f"Acousticness: {float(acousticness):.3f}")
    if instrumentalness is not None:
        values.append(f"Instrumentalness: {float(instrumentalness):.3f}")
    if tempo is not None:
        values.append(f"Tempo: {float(tempo):.1f}")
    return " | ".join(values)


def get_embeddings(texts: list[str]) -> list[list[float]]:
    response = httpx.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": EMBEDDING_MODEL, "input": texts},
        timeout=180,
    )
    response.raise_for_status()
    payload = response.json()
    embeddings = payload.get("embeddings")
    if not isinstance(embeddings, list) or len(embeddings) != len(texts):
        raise RuntimeError("Ollama returned an invalid embedding batch.")
    return embeddings


def print_progress(completed: int, total: int, started_at: float) -> None:
    percent = 100 if total == 0 else min(100, completed * 100 // total)
    elapsed = max(0.0, time.monotonic() - started_at)
    bar_width = 30
    filled = bar_width * percent // 100
    bar = "#" * filled + "-" * (bar_width - filled)
    elapsed_text = f"{elapsed:.1f}s"
    eta_text = ""
    if 0 < completed < total:
        eta_seconds = elapsed * (total - completed) / completed
        eta_text = f" ETA {eta_seconds:.1f}s"
    sys.stdout.write(
        f"\rEmbedding: [{bar}] {percent:3d}% ({completed}/{total}){eta_text} elapsed {elapsed_text}"
    )
    sys.stdout.flush()
    if completed >= total:
        sys.stdout.write("\n")


def main() -> None:
    transformed = Path(__file__).resolve().parent / "transformed"
    if not (transformed / "tracks.parquet").is_file():
        raise FileNotFoundError("Missing transformed catalog files.")

    connection = duckdb.connect()
    try:
        rows = connection.execute(
            """
            SELECT
                t.track_id,
                t.track_name,
                COALESCE(string_agg(DISTINCT ar.artist_name, ', ' ORDER BY ar.artist_name), ''),
                g.genre_name,
                tf.energy,
                tf.valence,
                tf.danceability,
                tf.acousticness,
                tf.instrumentalness,
                tf.tempo
            FROM read_parquet(?) t
            LEFT JOIN read_parquet(?) ta ON ta.track_id = t.track_id
            LEFT JOIN read_parquet(?) ar ON ar.artist_id = ta.artist_id
            LEFT JOIN read_parquet(?) g ON g.genre_id = t.genre_id
            LEFT JOIN read_parquet(?) tf ON tf.track_id = t.track_id
            GROUP BY t.track_id, t.track_name, g.genre_name, tf.energy, tf.valence,
                     tf.danceability, tf.acousticness, tf.instrumentalness, tf.tempo
            ORDER BY t.track_id
            """,
            [
                str(transformed / "tracks.parquet"),
                str(transformed / "track_artists.parquet"),
                str(transformed / "artists.parquet"),
                str(transformed / "genre.parquet"),
                str(transformed / "track_feel.parquet"),
            ],
        ).fetchall()
    finally:
        connection.close()
    if MAX_TRACKS > 0:
        rows = rows[:MAX_TRACKS]
    print(
        f"Preparing {len(rows)} catalog tracks in batches of {BATCH_SIZE} "
        f"with {EMBEDDING_MODEL}.",
        flush=True,
    )

    with psycopg2.connect(**DB_PARAMS) as postgres:
        with postgres.cursor() as cursor:
            cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")
            cursor.execute(
                """
                DROP TABLE IF EXISTS catalog_track_embedding;
                CREATE TABLE catalog_track_embedding (
                    snapshot_id TEXT NOT NULL,
                    catalog_track_id TEXT NOT NULL,
                    embedding vector(768) NOT NULL,
                    model_name TEXT NOT NULL,
                    text_hash TEXT,
                    PRIMARY KEY (snapshot_id, catalog_track_id)
                )
                """
            )

            values = []
            started_at = time.monotonic()
            completed = 0
            print_progress(completed, len(rows), started_at)
            for offset in range(0, len(rows), BATCH_SIZE):
                batch = rows[offset:offset + BATCH_SIZE]
                texts = [catalog_text(row) for row in batch]
                embeddings = get_embeddings(texts)
                for row, text, embedding in zip(batch, texts, embeddings):
                    if not isinstance(embedding, list) or len(embedding) != 768:
                        raise RuntimeError(
                            f"Unexpected embedding dimension for track {row[0]}: "
                            f"{len(embedding) if isinstance(embedding, list) else 'invalid'}"
                        )
                    values.append((
                        SNAPSHOT_ID,
                        str(row[0]),
                        "[" + ",".join(str(float(value)) for value in embedding) + "]",
                        EMBEDDING_MODEL,
                        hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    ))

                completed = min(len(rows), offset + len(batch))
                print_progress(completed, len(rows), started_at)

                if len(values) >= BATCH_SIZE * 4:
                    execute_values(
                        cursor,
                        """
                        INSERT INTO catalog_track_embedding
                            (snapshot_id, catalog_track_id, embedding, model_name, text_hash)
                        VALUES %s
                        """,
                        values,
                        template="(%s, %s, %s::vector(768), %s, %s)",
                        page_size=BATCH_SIZE,
                    )
                    values.clear()

            if values:
                execute_values(
                    cursor,
                    """
                    INSERT INTO catalog_track_embedding
                        (snapshot_id, catalog_track_id, embedding, model_name, text_hash)
                    VALUES %s
                    """,
                    values,
                    template="(%s, %s, %s::vector(768), %s, %s)",
                    page_size=BATCH_SIZE,
                )

            print("Embedding vectors stored. Creating pgvector HNSW cosine index...", flush=True)
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS catalog_track_embedding_cosine_idx
                ON catalog_track_embedding
                USING hnsw (embedding vector_cosine_ops)
                """
            )

    print(f"Embedded {len(rows)} catalog tracks with {EMBEDDING_MODEL}.")


if __name__ == "__main__":
    main()
