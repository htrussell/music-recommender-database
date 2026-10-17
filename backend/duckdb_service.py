import math
import os
import re
import threading
from pathlib import Path
from typing import Any, Literal

import duckdb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


DATA_DIR = Path(os.getenv("MUSIC_DATA_DIR", "/data/transformed"))
MUSICBRAINZ_PARQUET = Path(
    os.getenv("MUSICBRAINZ_PARQUET", "/data/musicbrainz/recordings.parquet")
)
DEMO_PROFILE_CSV = Path(
    os.getenv("DEMO_PROFILE_CSV", "/data/source/music_streaming_habits_2026.csv")
)
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
MAX_DEMO_PROFILE_TRACKS = 40
PROFILE_GENRE_CROSSWALK = {
    "Afrobeats": "afrobeats",
    "Classical": "classical",
    "Country": "country",
    "EDM": "edm",
    "Hip-Hop": "hip-hop",
    "Indie": "indie",
    "Jazz": "jazz",
    "K-Pop": "k-pop",
    "Lo-fi": "lo-fi",
    "Pop": "pop",
    "R&B": "r&b",
    "Rock": "rock",
}
PROFILE_GENRE_CROSSWALK_VERSION = 1
DEMO_PROFILE_COLUMNS = {
    "listener_id",
    "age",
    "country",
    "platform",
    "subscription",
    "top_genre",
    "top_artist",
    "daily_listening_minutes",
    "songs_per_day",
    "playlists_count",
    "skip_rate_pct",
    "discover_weekly_user",
    "top_mood",
    "uses_offline_mode",
    "podcasts_too",
}

app = FastAPI(title="Music Recommender DuckDB Catalog")
connection: duckdb.DuckDBPyConnection | None = None
connection_lock = threading.Lock()
musicbrainz_index_available = False
demo_profiles_available = False


class CatalogToolRequest(BaseModel):
    tool: Literal["search_tracks", "verify_tracks", "search_albums", "compare_genres"]
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
    global connection, musicbrainz_index_available, demo_profiles_available
    connection = duckdb.connect(":memory:")
    for table in MUSIC_TABLES:
        parquet_path = DATA_DIR / f"{table}.parquet"
        if not parquet_path.is_file():
            raise RuntimeError(f"Required DuckDB catalog source is missing: {parquet_path}")
        escaped_path = str(parquet_path).replace("'", "''")
        connection.execute(
            f'CREATE VIEW "{table}" AS SELECT * FROM read_parquet(\'{escaped_path}\')'
        )
    musicbrainz_index_available = MUSICBRAINZ_PARQUET.is_file()
    if musicbrainz_index_available:
        escaped_path = str(MUSICBRAINZ_PARQUET).replace("'", "''")
        connection.execute(
            "CREATE VIEW musicbrainz_recordings AS "
            f"SELECT * FROM read_parquet('{escaped_path}')"
        )
    demo_profiles_available = DEMO_PROFILE_CSV.is_file()
    if demo_profiles_available:
        escaped_path = str(DEMO_PROFILE_CSV).replace("'", "''")
        connection.execute(
            "CREATE VIEW demo_listener_profiles AS "
            f"SELECT * FROM read_csv_auto('{escaped_path}', header = true)"
        )
        profile_columns = {
            row[0] for row in connection.execute("DESCRIBE demo_listener_profiles").fetchall()
        }
        missing_columns = DEMO_PROFILE_COLUMNS - profile_columns
        if missing_columns:
            raise RuntimeError(
                "Demo profile CSV is missing required columns: "
                + ", ".join(sorted(missing_columns))
            )
        profile_count, distinct_ids, missing_ids = connection.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT listener_id),
                COUNT(*) FILTER (WHERE listener_id IS NULL)
            FROM demo_listener_profiles
            """
        ).fetchone()
        if profile_count == 0 or distinct_ids != profile_count or missing_ids:
            raise RuntimeError(
                "Demo profile CSV must contain at least one row with unique, non-null listener_id values."
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


def run_verify_tracks(arguments: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = arguments.get("tracks")
    if (
        not isinstance(candidates, list)
        or len(candidates) > 50
        or any(not isinstance(candidate, dict) for candidate in candidates)
    ):
        raise HTTPException(status_code=422, detail="Argument 'tracks' must be a list of at most 50 track objects.")

    verified: list[dict[str, Any]] = []
    if connection is None:
        raise HTTPException(status_code=503, detail="DuckDB catalog has not finished loading.")

    local_statement = """
        SELECT
            tracks.track_id AS catalog_track_id,
            tracks.track_name AS title,
            string_agg(DISTINCT artists.artist_name, ', ' ORDER BY artists.artist_name) AS artist,
            tracks.duration_ms,
            genre.genre_name AS genre,
            tracks.popularity,
            jaro_winkler_similarity(
                regexp_replace(lower(COALESCE(tracks.track_name, '')), '[^\\p{L}\\p{N}]+', '', 'g'),
                ?
            ) AS title_similarity,
            MAX(
                jaro_winkler_similarity(
                    regexp_replace(
                        lower(COALESCE(artists.artist_name, '')),
                        '[^\\p{L}\\p{N}]+',
                        '',
                        'g'
                    ),
                    ?
                )
            ) AS artist_similarity,
            MAX(
                CASE
                    WHEN regexp_replace(lower(COALESCE(artists.artist_name, '')), '[^\\p{L}\\p{N}]+', '', 'g') = ?
                    THEN 1 ELSE 0
                END
            ) AS candidate_artist_match
        FROM tracks
        LEFT JOIN track_artists ON tracks.track_id = track_artists.track_id
        LEFT JOIN artists ON track_artists.artist_id = artists.artist_id
        LEFT JOIN genre ON tracks.genre_id = genre.genre_id
        WHERE regexp_replace(lower(COALESCE(tracks.track_name, '')), '[^\\p{L}\\p{N}]+', '', 'g') = ?
           OR jaro_winkler_similarity(
                regexp_replace(lower(COALESCE(tracks.track_name, '')), '[^\\p{L}\\p{N}]+', '', 'g'),
                ?
           ) >= 0.60
        GROUP BY tracks.track_id, tracks.track_name, tracks.duration_ms, genre.genre_name, tracks.popularity
        HAVING regexp_replace(lower(COALESCE(tracks.track_name, '')), '[^\\p{L}\\p{N}]+', '', 'g') = ?
            OR jaro_winkler_similarity(
                regexp_replace(lower(COALESCE(tracks.track_name, '')), '[^\\p{L}\\p{N}]+', '', 'g'),
                ?
            ) >= 0.60
        ORDER BY candidate_artist_match DESC, title_similarity DESC,
                 artist_similarity DESC, tracks.popularity DESC NULLS LAST
        LIMIT 25
    """
    musicbrainz_statement = """
        SELECT
            'mb:' || recording_mbid AS catalog_track_id,
            title,
            artist,
            duration_ms,
            NULL AS genre,
            NULL AS popularity,
            1.0 AS title_similarity,
            jaro_winkler_similarity(
                regexp_replace(lower(COALESCE(artist, '')), '[^\\p{L}\\p{N}]+', '', 'g'),
                ?
            ) AS artist_similarity,
            CASE
                WHEN regexp_replace(lower(COALESCE(artist, '')), '[^\\p{L}\\p{N}]+', '', 'g') = ?
                THEN 1 ELSE 0
            END AS candidate_artist_match
        FROM musicbrainz_recordings
        WHERE title_key = ?
        LIMIT 10
    """

    for candidate_index in range(len(candidates)):
        candidate = candidates[candidate_index]
        if set(candidate) != {"title", "artist"}:
            raise HTTPException(
                status_code=422,
                detail="Each track to verify must contain only 'title' and 'artist'.",
            )
        title = candidate.get("title")
        artist = candidate.get("artist")
        if (
            not isinstance(title, str)
            or not isinstance(artist, str)
            or not title.strip()
            or not artist.strip()
            or len(title) > 300
            or len(artist) > 300
        ):
            raise HTTPException(
                status_code=422,
                detail="Track titles and artist names must be non-empty strings of at most 300 characters.",
            )
        normalized_title = re.sub(r"[\W_]+", "", title.lower(), flags=re.UNICODE)
        normalized_artist = re.sub(r"[\W_]+", "", artist.lower(), flags=re.UNICODE)
        rows = rows_from_cursor(
            connection.execute(
                local_statement,
                [
                    normalized_title,
                    normalized_artist,
                    normalized_artist,
                    normalized_title,
                    normalized_title,
                    normalized_title,
                    normalized_title,
                ],
            )
        )
        verified.extend(
            {"candidate_index": candidate_index, "source": "primary", **row}
            for row in rows
        )
        if musicbrainz_index_available:
            musicbrainz_rows = rows_from_cursor(
                connection.execute(
                    musicbrainz_statement,
                    [normalized_artist, normalized_artist, normalized_title],
                )
            )
            verified.extend(
                {"candidate_index": candidate_index, "source": "musicbrainz", **row}
                for row in musicbrainz_rows
            )
    return verified


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


def normalize_profile_label(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


@app.get("/demo-profiles/{listener_id}")
def get_demo_profile(listener_id: int) -> dict[str, Any]:
    if listener_id < 1:
        raise HTTPException(status_code=422, detail="Demo listener ID must be a positive integer.")
    if not demo_profiles_available:
        raise HTTPException(status_code=503, detail="The streaming-habits demo profile file is unavailable.")
    if connection is None:
        raise HTTPException(status_code=503, detail="DuckDB catalog has not finished loading.")

    with connection_lock:
        profile_rows = rows_from_cursor(
            connection.execute(
                """
                SELECT listener_id, age, country, platform, subscription, top_genre, top_artist,
                    daily_listening_minutes, songs_per_day, playlists_count, skip_rate_pct,
                    discover_weekly_user, top_mood, uses_offline_mode, podcasts_too
                FROM demo_listener_profiles
                WHERE listener_id = ?
                LIMIT 1
                """,
                [listener_id],
            )
        )
        if not profile_rows:
            raise HTTPException(status_code=404, detail=f"Demo listener {listener_id} was not found.")
        profile = profile_rows[0]

        normalized_artist = normalize_profile_label(str(profile["top_artist"]))
        artist_rows = rows_from_cursor(
            connection.execute(
                """
                SELECT DISTINCT artists.artist_id, artists.artist_name
                FROM artists
                WHERE regexp_replace(lower(artists.artist_name), '[^a-z0-9]', '', 'g') = ?
                LIMIT 2
                """,
                [normalized_artist],
            )
        )
        artist_mapping_status = (
            "matched" if len(artist_rows) == 1 else "unmatched" if not artist_rows else "ambiguous"
        )

        genre_target = PROFILE_GENRE_CROSSWALK.get(str(profile["top_genre"]))
        genre_rows = (
            rows_from_cursor(
                connection.execute(
                    """
                    SELECT genre_id, genre_name
                    FROM genre
                    WHERE lower(trim(genre_name)) = lower(?)
                    LIMIT 2
                    """,
                    [genre_target],
                )
            )
            if genre_target
            else []
        )
        genre_mapping_status = (
            "matched" if len(genre_rows) == 1 else "unmatched" if not genre_rows else "ambiguous"
        )

        if artist_mapping_status == "matched" or genre_mapping_status == "matched":
            conditions = []
            selection_parameters: list[Any] = []
            filter_parameters: list[Any] = []
            artist_select = "0"
            genre_select = "0"
            if artist_mapping_status == "matched":
                artist_id = artist_rows[0]["artist_id"]
                artist_select = "MAX(CASE WHEN artists.artist_id = ? THEN 1 ELSE 0 END)"
                selection_parameters.append(artist_id)
                conditions.append(
                    "tracks.track_id IN (SELECT track_id FROM track_artists WHERE artist_id = ?)"
                )
                filter_parameters.append(artist_id)
            if genre_mapping_status == "matched":
                genre_id = genre_rows[0]["genre_id"]
                genre_select = "MAX(CASE WHEN tracks.genre_id = ? THEN 1 ELSE 0 END)"
                selection_parameters.append(genre_id)
                conditions.append("tracks.genre_id = ?")
                filter_parameters.append(genre_id)
            matched_tracks = rows_from_cursor(
                connection.execute(
                    f"""
                    SELECT tracks.track_id AS catalog_track_id, tracks.track_name AS title,
                        string_agg(DISTINCT artists.artist_name, ', '
                            ORDER BY artists.artist_name) AS artist,
                        tracks.duration_ms, genre.genre_name AS genre, tracks.popularity,
                        {artist_select} AS matched_artist,
                        {genre_select} AS matched_genre
                    FROM tracks
                    LEFT JOIN track_artists ON tracks.track_id = track_artists.track_id
                    LEFT JOIN artists ON track_artists.artist_id = artists.artist_id
                    LEFT JOIN genre ON tracks.genre_id = genre.genre_id
                    WHERE {' OR '.join(conditions)}
                    GROUP BY tracks.track_id, tracks.track_name, tracks.duration_ms,
                        genre.genre_name, tracks.popularity
                    ORDER BY matched_artist DESC,
                        tracks.popularity DESC NULLS LAST, tracks.track_name
                    LIMIT ?
                    """,
                    [*selection_parameters, *filter_parameters, MAX_DEMO_PROFILE_TRACKS],
                )
            )
            for track in matched_tracks:
                sources = []
                if track.pop("matched_artist"):
                    sources.append("top_artist")
                if track.pop("matched_genre"):
                    sources.append("top_genre")
                track["profile_match"] = sources
        else:
            matched_tracks = []

    return {
        "profile": profile,
        "artist_mapping_status": artist_mapping_status,
        "genre_mapping_status": genre_mapping_status,
        "genre_crosswalk_version": PROFILE_GENRE_CROSSWALK_VERSION,
        "matched_genre": genre_rows[0] if genre_mapping_status == "matched" else None,
        "tracks": matched_tracks,
    }


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
        "verify_tracks": {"tracks"},
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
        elif request.tool == "verify_tracks":
            rows = run_verify_tracks(arguments)
        elif request.tool == "search_albums":
            rows = run_search_albums(arguments, limit)
        else:
            rows = run_compare_genres(arguments, limit)
    return {"rows": rows}
