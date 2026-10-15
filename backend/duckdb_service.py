import math
import os
import threading
from pathlib import Path
from typing import Any, Literal

import duckdb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


DATA_DIR = Path(os.getenv("MUSIC_DATA_DIR", "/data/transformed"))
MUSIC_TABLES = (
    "album",
    "album_scores",
    "artist_genres",
    "artists",
    "genre",
    "track_artists",
    "track_feel",
    "tracks",
)
MAX_QUERY_ROWS = 100

app = FastAPI(title="Music Recommender DuckDB Catalog")
connection: duckdb.DuckDBPyConnection | None = None
connection_lock = threading.Lock()


class CatalogToolRequest(BaseModel):
    tool: Literal["search_tracks", "search_albums", "compare_genres"]
    arguments: dict[str, Any] = Field(default_factory=dict)


def read_text(arguments: dict[str, Any], key: str, maximum_length: int = 200) -> str | None:
    value = arguments.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum_length:
        raise HTTPException(status_code=422, detail=f"Argument '{key}' must be a string of at most {maximum_length} characters.")
    value = value.strip()
    return value or None


def read_number(
    arguments: dict[str, Any],
    key: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float | None:
    value = arguments.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise HTTPException(status_code=422, detail=f"Argument '{key}' must be a finite number.")
    if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        raise HTTPException(status_code=422, detail=f"Argument '{key}' is outside the allowed range.")
    return float(value)


def read_limit(arguments: dict[str, Any]) -> int:
    value = arguments.get("limit", MAX_QUERY_ROWS)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise HTTPException(status_code=422, detail="Argument 'limit' must be a positive integer.")
    return min(value, MAX_QUERY_ROWS)


def read_exclusions(arguments: dict[str, Any]) -> list[str]:
    value = arguments.get("exclude_terms", [])
    if not isinstance(value, list) or any(not isinstance(term, str) for term in value):
        raise HTTPException(status_code=422, detail="Argument 'exclude_terms' must be a list of strings.")
    terms = [term.strip() for term in value if term.strip()]
    if len(terms) > 20 or any(len(term) > 100 for term in terms):
        raise HTTPException(status_code=422, detail="At most 20 exclusion terms of up to 100 characters are allowed.")
    return terms


def rows_from_cursor(cursor: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


@app.on_event("startup")
def load_music_catalog() -> None:
    global connection
    connection = duckdb.connect(":memory:")
    for table in MUSIC_TABLES:
        csv_path = DATA_DIR / f"{table}.csv"
        if not csv_path.is_file():
            raise RuntimeError(f"Required DuckDB catalog source is missing: {csv_path}")
        escaped_path = str(csv_path).replace("'", "''")
        connection.execute(
            f'CREATE TABLE "{table}" AS SELECT * FROM read_csv_auto(\'{escaped_path}\', header = true)'
        )


def run_search_tracks(arguments: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    query = read_text(arguments, "query")
    genre = read_text(arguments, "genre")
    artist = read_text(arguments, "artist")
    maximum_duration_ms = read_number(arguments, "maximum_duration_ms", minimum=1)
    minimum_energy = read_number(arguments, "minimum_energy", minimum=0, maximum=1)
    exclude_explicit = arguments.get("exclude_explicit", False)
    if not isinstance(exclude_explicit, bool):
        raise HTTPException(status_code=422, detail="Argument 'exclude_explicit' must be a boolean.")
    exclusions = read_exclusions(arguments)

    conditions: list[str] = []
    parameters: list[Any] = []
    if query:
        pattern = f"%{query}%"
        conditions.append(
            "(tracks.track_name ILIKE ? OR artists.artist_name ILIKE ? OR genre.genre_name ILIKE ?)"
        )
        parameters.extend((pattern, pattern, pattern))
    if genre:
        conditions.append("genre.genre_name ILIKE ?")
        parameters.append(f"%{genre}%")
    if artist:
        conditions.append("artists.artist_name ILIKE ?")
        parameters.append(f"%{artist}%")
    if maximum_duration_ms is not None:
        conditions.append("tracks.duration_ms <= ?")
        parameters.append(maximum_duration_ms)
    if minimum_energy is not None:
        conditions.append("track_feel.energy >= ?")
        parameters.append(minimum_energy)
    if exclude_explicit:
        conditions.append("COALESCE(tracks.explicit, false) = false")
    for term in exclusions:
        pattern = f"%{term}%"
        conditions.append(
            "(COALESCE(tracks.track_name, '') NOT ILIKE ? "
            "AND COALESCE(artists.artist_name, '') NOT ILIKE ? "
            "AND COALESCE(genre.genre_name, '') NOT ILIKE ?)"
        )
        parameters.extend((pattern, pattern, pattern))
    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    statement = f"""
        SELECT
            tracks.track_id AS catalog_track_id,
            tracks.track_name AS title,
            string_agg(DISTINCT artists.artist_name, ', ' ORDER BY artists.artist_name) AS artist,
            tracks.duration_ms,
            genre.genre_name AS genre,
            track_feel.energy,
            track_feel.valence,
            track_feel.danceability,
            track_feel.acousticness,
            track_feel.instrumentalness,
            track_feel.tempo,
            tracks.popularity,
            tracks.explicit
        FROM tracks
        LEFT JOIN track_artists ON tracks.track_id = track_artists.track_id
        LEFT JOIN artists ON track_artists.artist_id = artists.artist_id
        LEFT JOIN genre ON tracks.genre_id = genre.genre_id
        LEFT JOIN track_feel ON tracks.track_id = track_feel.track_id
        {where_clause}
        GROUP BY
            tracks.track_id, tracks.track_name, tracks.duration_ms, genre.genre_name,
            track_feel.energy, track_feel.valence, track_feel.danceability,
            track_feel.acousticness, track_feel.instrumentalness, track_feel.tempo,
            tracks.popularity, tracks.explicit
        ORDER BY tracks.popularity DESC NULLS LAST
        LIMIT ?
    """
    parameters.append(limit)
    if connection is None:
        raise HTTPException(status_code=503, detail="DuckDB catalog has not finished loading.")
    return rows_from_cursor(connection.execute(statement, parameters))


def run_search_albums(arguments: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    query = read_text(arguments, "query")
    genre = read_text(arguments, "genre")
    minimum_critic_score = read_number(arguments, "minimum_critic_score", minimum=0, maximum=100)
    year_start = read_number(arguments, "year_start", minimum=0, maximum=9999)
    year_end = read_number(arguments, "year_end", minimum=0, maximum=9999)
    conditions: list[str] = []
    parameters: list[Any] = []
    if query:
        conditions.append("album.album_name ILIKE ?")
        parameters.append(f"%{query}%")
    if genre:
        conditions.append("genre.genre_name ILIKE ?")
        parameters.append(f"%{genre}%")
    if minimum_critic_score is not None:
        conditions.append("album_scores.metacritic_critic_score >= ?")
        parameters.append(minimum_critic_score)
    if year_start is not None:
        conditions.append("TRY_CAST(SUBSTRING(album.release_date, 1, 4) AS INTEGER) >= ?")
        parameters.append(year_start)
    if year_end is not None:
        conditions.append("TRY_CAST(SUBSTRING(album.release_date, 1, 4) AS INTEGER) <= ?")
        parameters.append(year_end)
    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    statement = f"""
        SELECT
            album.album_id,
            album.album_name,
            album.album_format,
            album.release_date,
            album.label,
            genre.genre_name AS genre,
            album_scores.metacritic_critic_score,
            album_scores.metacritic_user_score,
            album_scores.aoty_critic_score
        FROM album
        LEFT JOIN genre ON album.genre_id = genre.genre_id
        LEFT JOIN album_scores ON album.album_id = album_scores.album_id
        {where_clause}
        ORDER BY album_scores.metacritic_critic_score DESC NULLS LAST
        LIMIT ?
    """
    parameters.append(limit)
    if connection is None:
        raise HTTPException(status_code=503, detail="DuckDB catalog has not finished loading.")
    return rows_from_cursor(connection.execute(statement, parameters))


def run_compare_genres(arguments: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    genres = arguments.get("genres", [])
    if not isinstance(genres, list) or any(not isinstance(item, str) for item in genres):
        raise HTTPException(status_code=422, detail="Argument 'genres' must be a list of strings.")
    if len(genres) > 20 or any(len(item) > 100 for item in genres):
        raise HTTPException(status_code=422, detail="At most 20 genre names of up to 100 characters are allowed.")
    statement = """
        SELECT
            genre.genre_id,
            genre.genre_name,
            COUNT(DISTINCT tracks.track_id) AS track_count,
            ROUND(AVG(tracks.popularity), 2) AS average_popularity,
            ROUND(AVG(track_feel.energy), 3) AS average_energy,
            ROUND(AVG(track_feel.danceability), 3) AS average_danceability,
            ROUND(AVG(track_feel.tempo), 2) AS average_tempo,
            ROUND(100.0 * COUNT(DISTINCT CASE WHEN tracks.explicit THEN tracks.track_id END)
                / NULLIF(COUNT(DISTINCT tracks.track_id), 0), 2) AS explicit_percentage
        FROM genre
        JOIN tracks ON tracks.genre_id = genre.genre_id
        LEFT JOIN track_feel ON tracks.track_id = track_feel.track_id
    """
    parameters: list[Any] = []
    if genres:
        statement += " WHERE " + " OR ".join("genre.genre_name ILIKE ?" for _ in genres)
        parameters.extend(f"%{name}%" for name in genres)
    statement += """
        GROUP BY genre.genre_id, genre.genre_name
        ORDER BY average_popularity DESC NULLS LAST
        LIMIT ?
    """
    parameters.append(limit)
    if connection is None:
        raise HTTPException(status_code=503, detail="DuckDB catalog has not finished loading.")
    return rows_from_cursor(connection.execute(statement, parameters))


@app.get("/healthz")
def healthcheck() -> dict[str, str]:
    if connection is None:
        raise HTTPException(status_code=503, detail="DuckDB catalog is not loaded.")
    with connection_lock:
        connection.execute("SELECT 1")
    return {"status": "ok", "engine": "duckdb"}


@app.post("/tools/query")
def query_catalog(request: CatalogToolRequest) -> dict[str, Any]:
    arguments = request.arguments
    limit = read_limit(arguments)
    supported_arguments = {
        "search_tracks": {
            "query",
            "genre",
            "artist",
            "exclude_terms",
            "maximum_duration_ms",
            "minimum_energy",
            "exclude_explicit",
            "limit",
        },
        "search_albums": {
            "query",
            "genre",
            "minimum_critic_score",
            "year_start",
            "year_end",
            "limit",
        },
        "compare_genres": {"genres", "limit"},
    }[request.tool]
    unexpected_arguments = set(arguments) - supported_arguments
    if unexpected_arguments:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported argument(s) for {request.tool}: {', '.join(sorted(unexpected_arguments))}",
        )
    with connection_lock:
        if request.tool == "search_tracks":
            rows = run_search_tracks(arguments, limit)
        elif request.tool == "search_albums":
            rows = run_search_albums(arguments, limit)
        else:
            rows = run_compare_genres(arguments, limit)
    return {"rows": rows}
