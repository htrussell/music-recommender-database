import csv
from decimal import Decimal, InvalidOperation
from io import StringIO
from pathlib import Path

import duckdb
import psycopg2


# Connect to the Postgres service defined in docker-compose.yml.
DB_PARAMS = {
    "dbname": "track-db",
    "user": "airflow",
    "password": "airflow",
    "host": "postgres",
    "port": "5432",
}

# Drop child tables before parents so reruns do not cascade into unrelated tables.
DROP_STATEMENTS = """
DROP TABLE IF EXISTS track_feel;
DROP TABLE IF EXISTS track_artists;
DROP TABLE IF EXISTS artist_genres;
DROP TABLE IF EXISTS album_scores;
DROP TABLE IF EXISTS tracks;
DROP TABLE IF EXISTS album;
DROP TABLE IF EXISTS artists;
DROP TABLE IF EXISTS genre;
"""

DDL_STATEMENTS = """
CREATE TABLE genre (
    genre_id INTEGER CONSTRAINT genre_pkey PRIMARY KEY,
    genre_name VARCHAR(255)
);

CREATE TABLE artists (
    artist_id INTEGER CONSTRAINT artists_pkey PRIMARY KEY,
    artist_name VARCHAR(512),
    artist_country TEXT,
    artist_popularity DOUBLE PRECISION
);

CREATE TABLE album (
    album_id INTEGER CONSTRAINT album_pkey PRIMARY KEY,
    genre_id INTEGER,
    album_name VARCHAR(1000),
    album_format VARCHAR(100),
    release_date VARCHAR(50),
    label VARCHAR(512),
    CONSTRAINT album_genre_id_fkey
        FOREIGN KEY (genre_id) REFERENCES genre (genre_id)
);

CREATE TABLE tracks (
    track_id VARCHAR(50) CONSTRAINT tracks_pkey PRIMARY KEY,
    album_id INTEGER,
    genre_id INTEGER,
    track_name VARCHAR(1000),
    popularity INTEGER,
    duration_ms INTEGER,
    explicit BOOLEAN,
    CONSTRAINT tracks_album_id_fkey
        FOREIGN KEY (album_id) REFERENCES album (album_id),
    CONSTRAINT tracks_genre_id_fkey
        FOREIGN KEY (genre_id) REFERENCES genre (genre_id)
);

CREATE TABLE album_scores (
    album_id INTEGER CONSTRAINT album_scores_pkey PRIMARY KEY,
    metacritic_critic_score DOUBLE PRECISION,
    metacritic_critic_count INTEGER,
    metacritic_user_score DOUBLE PRECISION,
    metacritic_user_count INTEGER,
    aoty_critic_score DOUBLE PRECISION,
    aoty_critic_count INTEGER,
    aoty_user_score DOUBLE PRECISION,
    aoty_user_count INTEGER,
    CONSTRAINT album_scores_album_id_fkey
        FOREIGN KEY (album_id) REFERENCES album (album_id)
);

CREATE TABLE track_feel (
    track_id VARCHAR(50) CONSTRAINT track_feel_pkey PRIMARY KEY,
    danceability DOUBLE PRECISION,
    energy DOUBLE PRECISION,
    key INTEGER,
    loudness DOUBLE PRECISION,
    mode INTEGER,
    speechiness DOUBLE PRECISION,
    acousticness DOUBLE PRECISION,
    instrumentalness DOUBLE PRECISION,
    liveness DOUBLE PRECISION,
    valence DOUBLE PRECISION,
    tempo DOUBLE PRECISION,
    time_signature INTEGER,
    CONSTRAINT track_feel_track_id_fkey
        FOREIGN KEY (track_id) REFERENCES tracks (track_id)
);

CREATE TABLE track_artists (
    track_id VARCHAR(50),
    artist_id INTEGER,
    CONSTRAINT track_artists_pkey PRIMARY KEY (track_id, artist_id),
    CONSTRAINT track_artists_track_id_fkey
        FOREIGN KEY (track_id) REFERENCES tracks (track_id),
    CONSTRAINT track_artists_artist_id_fkey
        FOREIGN KEY (artist_id) REFERENCES artists (artist_id)
);

CREATE TABLE artist_genres (
    artist_id INTEGER,
    genre_id INTEGER,
    CONSTRAINT artist_genres_pkey PRIMARY KEY (artist_id, genre_id),
    CONSTRAINT artist_genres_artist_id_fkey
        FOREIGN KEY (artist_id) REFERENCES artists (artist_id),
    CONSTRAINT artist_genres_genre_id_fkey
        FOREIGN KEY (genre_id) REFERENCES genre (genre_id)
);
"""

# Column order is checked against each generated Parquet file before the database is changed.
TABLE_PARQUET_MAP = (
    ("genre", "genre.parquet", ("genre_id", "genre_name")),
    (
        "artists",
        "artists.parquet",
        ("artist_id", "artist_name", "artist_country", "artist_popularity"),
    ),
    (
        "album",
        "album.parquet",
        ("album_id", "genre_id", "album_name", "album_format", "release_date", "label"),
    ),
    (
        "tracks",
        "tracks.parquet",
        (
            "track_id",
            "album_id",
            "genre_id",
            "track_name",
            "popularity",
            "duration_ms",
            "explicit",
        ),
    ),
    (
        "album_scores",
        "album_scores.parquet",
        (
            "album_id",
            "metacritic_critic_score",
            "metacritic_critic_count",
            "metacritic_user_score",
            "metacritic_user_count",
            "aoty_critic_score",
            "aoty_critic_count",
            "aoty_user_score",
            "aoty_user_count",
        ),
    ),
    (
        "track_feel",
        "track_feel.parquet",
        (
            "track_id",
            "danceability",
            "energy",
            "key",
            "loudness",
            "mode",
            "speechiness",
            "acousticness",
            "instrumentalness",
            "liveness",
            "valence",
            "tempo",
            "time_signature",
        ),
    ),
    ("track_artists", "track_artists.parquet", ("track_id", "artist_id")),
    ("artist_genres", "artist_genres.parquet", ("artist_id", "genre_id")),
)

INTEGER_PARQUET_COLUMNS = {
    "genre": ("genre_id",),
    "artists": ("artist_id",),
    "album": ("album_id", "genre_id"),
    "tracks": ("album_id", "genre_id", "popularity", "duration_ms"),
    "album_scores": (
        "album_id",
        "metacritic_critic_count",
        "metacritic_user_count",
        "aoty_critic_count",
        "aoty_user_count",
    ),
    "track_feel": ("key", "mode", "time_signature"),
    "track_artists": ("artist_id",),
    "artist_genres": ("artist_id", "genre_id"),
}


def validate_parquet_files(parquet_dir: Path) -> dict[str, Path]:
    """Ensure every expected Parquet file exists and matches the loader schema."""
    parquet_paths = {}
    for table_name, filename, expected_columns in TABLE_PARQUET_MAP:
        filepath = parquet_dir / filename
        if not filepath.is_file():
            raise FileNotFoundError(f"Required transformed data file not found: {filepath}")

        actual_columns = tuple(
            row[0]
            for row in duckdb.sql(
                "DESCRIBE SELECT * FROM read_parquet(?)",
                params=[str(filepath)],
            ).fetchall()
        )
        if actual_columns != expected_columns:
            raise ValueError(
                f"Unexpected columns in {filepath}: "
                f"expected {expected_columns}, found {actual_columns}"
            )
        parquet_paths[table_name] = filepath
    return parquet_paths


def copy_parquet_to_postgres(
    cursor: psycopg2.extensions.cursor,
    table_name: str,
    filepath: Path,
    columns: tuple[str, ...],
    integer_columns: tuple[str, ...],
) -> None:
    """Stream Parquet rows to PostgreSQL in bounded CSV batches."""
    connection = duckdb.connect()
    try:
        reader = connection.execute("SELECT * FROM read_parquet(?)", [str(filepath)])
        integer_indexes = {columns.index(column) for column in integer_columns}
        copy_sql = (
            f"COPY {table_name} ({', '.join(columns)}) "
            "FROM STDIN WITH (FORMAT CSV, NULL '')"
        )
        while rows := reader.fetchmany(10_000):
            batch = StringIO(newline="")
            writer = csv.writer(batch, lineterminator="\n")
            for row_number, row in enumerate(rows, start=1):
                normalized = list(row)
                for index in integer_indexes:
                    value = normalized[index]
                    if value is None:
                        continue
                    try:
                        decimal_value = Decimal(str(value))
                    except InvalidOperation as exc:
                        raise ValueError(
                            f"Invalid integer value in {filepath}, batch row {row_number}: {value!r}"
                        ) from exc
                    if not decimal_value.is_finite() or decimal_value != decimal_value.to_integral_value():
                        raise ValueError(
                            f"Non-integral value in {filepath}, batch row {row_number}: {value!r}"
                        )
                    normalized[index] = int(decimal_value)
                writer.writerow(["" if value is None else value for value in normalized])
            batch.seek(0)
            cursor.copy_expert(sql=copy_sql, file=batch)
    finally:
        connection.close()


def main() -> None:
    parquet_dir = Path(__file__).resolve().parent / "transformed"
    parquet_paths = validate_parquet_files(parquet_dir)

    print("Connecting to PostgreSQL...")
    with psycopg2.connect(**DB_PARAMS) as conn:
        with conn.cursor() as cur:
            print("Building database schema and applying constraints...")
            cur.execute(DROP_STATEMENTS)
            cur.execute(DDL_STATEMENTS)

            for table_name, _, columns in TABLE_PARQUET_MAP:
                print(f"Loading data into {table_name}...")
                copy_parquet_to_postgres(
                    cur,
                    table_name,
                    parquet_paths[table_name],
                    columns,
                    INTEGER_PARQUET_COLUMNS.get(table_name, ()),
                )

            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", ("music_reader",))
            if cur.fetchone():
                cur.execute(
                    """
                    GRANT SELECT ON TABLE
                        album, album_scores, artist_genres, artists, genre,
                        track_artists, track_feel, tracks
                    TO music_reader
                    """
                )

    print("\nSuccess! Database is fully populated and relational constraints are active.")


if __name__ == "__main__":
    main()
