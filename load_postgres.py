import csv
from decimal import Decimal, InvalidOperation
from io import StringIO
from pathlib import Path

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

# Column order is checked against each generated CSV before the database is changed.
TABLE_CSV_MAP = (
    ("genre", "genre.csv", ("genre_id", "genre_name")),
    (
        "artists",
        "artists.csv",
        ("artist_id", "artist_name", "artist_country", "artist_popularity"),
    ),
    (
        "album",
        "album.csv",
        ("album_id", "genre_id", "album_name", "album_format", "release_date", "label"),
    ),
    (
        "tracks",
        "tracks.csv",
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
        "album_scores.csv",
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
        "track_feel.csv",
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
    ("track_artists", "track_artists.csv", ("track_id", "artist_id")),
    ("artist_genres", "artist_genres.csv", ("artist_id", "genre_id")),
)

INTEGER_CSV_COLUMNS = {
    "album_scores": (
        "metacritic_critic_count",
        "metacritic_user_count",
        "aoty_critic_count",
        "aoty_user_count",
    ),
}


def validate_csv_files(csv_dir: Path) -> dict[str, Path]:
    """Ensure every expected CSV exists and matches the loader's column order."""
    csv_paths = {}
    for table_name, filename, expected_columns in TABLE_CSV_MAP:
        filepath = csv_dir / filename
        if not filepath.is_file():
            raise FileNotFoundError(f"Required transformed data file not found: {filepath}")

        with filepath.open("r", encoding="utf-8", newline="") as csv_file:
            actual_columns = next(csv.reader(csv_file), None)
        if tuple(actual_columns or ()) != expected_columns:
            raise ValueError(
                f"Unexpected columns in {filepath}: "
                f"expected {expected_columns}, found {actual_columns}"
            )
        csv_paths[table_name] = filepath
    return csv_paths


def prepare_csv_for_copy(filepath: Path, integer_columns: tuple[str, ...]) -> StringIO:
    """Normalize integer-valued CSV cells that were exported with a decimal suffix."""
    normalized_csv = StringIO(newline="")
    with filepath.open("r", encoding="utf-8", newline="") as csv_file:
        reader = csv.reader(csv_file)
        header = next(reader)
        column_indexes = {column: header.index(column) for column in integer_columns}
        writer = csv.writer(normalized_csv, lineterminator="\n")
        writer.writerow(header)

        for line_number, row in enumerate(reader, start=2):
            for column, index in column_indexes.items():
                value = row[index]
                if not value:
                    continue
                try:
                    decimal_value = Decimal(value)
                except InvalidOperation as exc:
                    raise ValueError(
                        f"Invalid integer value in {filepath}, line {line_number}, "
                        f"column {column}: {value!r}"
                    ) from exc
                if not decimal_value.is_finite() or decimal_value != decimal_value.to_integral_value():
                    raise ValueError(
                        f"Non-integral value in {filepath}, line {line_number}, "
                        f"column {column}: {value!r}"
                    )
                row[index] = str(int(decimal_value))
            writer.writerow(row)

    normalized_csv.seek(0)
    return normalized_csv


def main() -> None:
    csv_dir = Path(__file__).resolve().parent / "transformed"
    csv_paths = validate_csv_files(csv_dir)

    print("Connecting to PostgreSQL...")
    with psycopg2.connect(**DB_PARAMS) as conn:
        with conn.cursor() as cur:
            print("Building database schema and applying constraints...")
            cur.execute(DROP_STATEMENTS)
            cur.execute(DDL_STATEMENTS)

            for table_name, _, columns in TABLE_CSV_MAP:
                print(f"Loading data into {table_name}...")
                column_list = ", ".join(columns)
                copy_sql = (
                    f"COPY {table_name} ({column_list}) "
                    "FROM STDIN WITH (FORMAT CSV, HEADER TRUE, NULL '')"
                )
                integer_columns = INTEGER_CSV_COLUMNS.get(table_name, ())
                csv_context = (
                    prepare_csv_for_copy(csv_paths[table_name], integer_columns)
                    if integer_columns
                    else csv_paths[table_name].open("r", encoding="utf-8", newline="")
                )
                with csv_context as csv_file:
                    cur.copy_expert(sql=copy_sql, file=csv_file)

    print("\nSuccess! Database is fully populated and relational constraints are active.")


if __name__ == "__main__":
    main()
