import unittest

import duckdb
from fastapi import HTTPException

import duckdb_service


class DuckDBCatalogToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_connection = duckdb_service.connection
        duckdb_service.connection = duckdb.connect(":memory:")
        connection = duckdb_service.connection
        connection.execute(
            """
            CREATE TABLE tracks (
                track_id VARCHAR, track_name VARCHAR, duration_ms INTEGER, genre_id INTEGER,
                popularity INTEGER, explicit BOOLEAN, album_id INTEGER
            );
            CREATE TABLE artists (artist_id INTEGER, artist_name VARCHAR, artist_country VARCHAR, artist_popularity DOUBLE);
            CREATE TABLE track_artists (track_id VARCHAR, artist_id INTEGER);
            CREATE TABLE genre (genre_id INTEGER, genre_name VARCHAR);
            CREATE TABLE track_feel (
                track_id VARCHAR, energy DOUBLE, valence DOUBLE, danceability DOUBLE,
                acousticness DOUBLE, instrumentalness DOUBLE, tempo DOUBLE
            );
            CREATE TABLE album (
                album_id INTEGER, album_name VARCHAR, album_format VARCHAR, release_date VARCHAR,
                label VARCHAR, genre_id INTEGER
            );
            CREATE TABLE album_scores (
                album_id INTEGER, metacritic_critic_score DOUBLE, metacritic_user_score DOUBLE,
                aoty_critic_score DOUBLE
            );
            INSERT INTO tracks VALUES
                ('t1', 'Blue Train', 600000, 1, 90, false, 1),
                ('t2', 'Blue Note', 900000, 1, 70, true, 2);
            INSERT INTO artists VALUES
                (1, 'Alice', 'US', 80),
                (2, 'Bob', 'UK', 75);
            INSERT INTO track_artists VALUES ('t1', 1), ('t2', 2);
            INSERT INTO genre VALUES (1, 'Jazz');
            INSERT INTO track_feel VALUES
                ('t1', 0.8, 0.5, 0.7, 0.2, 0.1, 120),
                ('t2', 0.4, 0.6, 0.6, 0.3, 0.2, 110);
            INSERT INTO album VALUES
                (1, 'Blue Train', 'LP', '1957-09-15', 'Blue Note', 1),
                (2, 'Blue Note', 'LP', '1960-01-01', 'Blue Note', 1);
            INSERT INTO album_scores VALUES (1, 95, 90, 92), (2, 80, 85, 82);
            """
        )

    def tearDown(self) -> None:
        assert duckdb_service.connection is not None
        duckdb_service.connection.close()
        duckdb_service.connection = self.previous_connection

    def test_track_search_uses_bound_filters_and_applies_explicit_exclusion(self) -> None:
        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="search_tracks",
                arguments={
                    "query": "Blue",
                    "genre": "Jazz",
                    "maximum_duration_ms": 700000,
                    "minimum_energy": 0.7,
                    "exclude_explicit": True,
                },
            )
        )

        self.assertEqual(len(response["rows"]), 1)
        self.assertEqual(response["rows"][0]["catalog_track_id"], "t1")
        self.assertEqual(response["rows"][0]["artist"], "Alice")

    def test_track_search_treats_search_text_as_data(self) -> None:
        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="search_tracks",
                arguments={"query": "' OR true --"},
            )
        )

        self.assertEqual(response["rows"], [])

    def test_compare_genres_returns_aggregate_statistics(self) -> None:
        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="compare_genres",
                arguments={"genres": ["Jazz"]},
            )
        )

        self.assertEqual(response["rows"][0]["genre_name"], "Jazz")
        self.assertEqual(response["rows"][0]["track_count"], 2)

    def test_rejects_tool_arguments_outside_the_supported_schema(self) -> None:
        with self.assertRaises(HTTPException) as error:
            duckdb_service.query_catalog(
                duckdb_service.CatalogToolRequest(
                    tool="search_tracks",
                    arguments={"unexpected": "value"},
                )
            )

        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
