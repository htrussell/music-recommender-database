import unittest

import duckdb
from fastapi import HTTPException

import duckdb_service


class DuckDBCatalogToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_connection = duckdb_service.connection
        self.previous_musicbrainz_index_available = duckdb_service.musicbrainz_index_available
        self.previous_demo_profiles_available = duckdb_service.demo_profiles_available
        duckdb_service.musicbrainz_index_available = False
        duckdb_service.demo_profiles_available = False
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
        duckdb_service.musicbrainz_index_available = self.previous_musicbrainz_index_available
        duckdb_service.demo_profiles_available = self.previous_demo_profiles_available

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

    def test_demo_profile_maps_artist_and_genre_to_bounded_catalog_tracks(self) -> None:
        assert duckdb_service.connection is not None
        duckdb_service.connection.execute(
            """
            CREATE TABLE demo_listener_profiles (
                listener_id INTEGER, age INTEGER, country VARCHAR, platform VARCHAR,
                subscription VARCHAR, top_genre VARCHAR, top_artist VARCHAR,
                daily_listening_minutes INTEGER, songs_per_day INTEGER, playlists_count INTEGER,
                skip_rate_pct DOUBLE, discover_weekly_user BOOLEAN, top_mood VARCHAR,
                uses_offline_mode BOOLEAN, podcasts_too BOOLEAN
            )
            """
        )
        duckdb_service.connection.execute(
            "INSERT INTO demo_listener_profiles VALUES "
            "(1, 24, 'US', 'Spotify', 'Free', 'Jazz', 'Alice', 90, 20, 3, "
            "12.5, true, 'Focus', false, true)"
        )
        duckdb_service.demo_profiles_available = True

        response = duckdb_service.get_demo_profile(1)

        self.assertEqual(response["profile"]["listener_id"], 1)
        self.assertEqual(response["artist_mapping_status"], "matched")
        self.assertEqual(response["genre_mapping_status"], "matched")
        self.assertEqual(response["matched_genre"]["genre_name"], "Jazz")
        self.assertEqual(
            {track["catalog_track_id"] for track in response["tracks"]},
            {"t1", "t2"},
        )
        alice_track = next(track for track in response["tracks"] if track["catalog_track_id"] == "t1")
        self.assertEqual(alice_track["artist"], "Alice")
        self.assertEqual(alice_track["profile_match"], ["top_artist", "top_genre"])

    def test_demo_profile_reports_unmatched_labels_and_unknown_ids(self) -> None:
        assert duckdb_service.connection is not None
        duckdb_service.connection.execute(
            """
            CREATE TABLE demo_listener_profiles (
                listener_id INTEGER, age INTEGER, country VARCHAR, platform VARCHAR,
                subscription VARCHAR, top_genre VARCHAR, top_artist VARCHAR,
                daily_listening_minutes INTEGER, songs_per_day INTEGER, playlists_count INTEGER,
                skip_rate_pct DOUBLE, discover_weekly_user BOOLEAN, top_mood VARCHAR,
                uses_offline_mode BOOLEAN, podcasts_too BOOLEAN
            )
            """
        )
        duckdb_service.connection.execute(
            "INSERT INTO demo_listener_profiles VALUES "
            "(1, 24, 'US', 'Spotify', 'Free', 'Unmapped', 'Unknown Artist', 90, 20, 3, "
            "12.5, true, 'Focus', false, true)"
        )
        duckdb_service.demo_profiles_available = True

        response = duckdb_service.get_demo_profile(1)

        self.assertEqual(response["artist_mapping_status"], "unmatched")
        self.assertEqual(response["genre_mapping_status"], "unmatched")
        self.assertEqual(response["tracks"], [])
        with self.assertRaises(HTTPException) as error:
            duckdb_service.get_demo_profile(2)
        self.assertEqual(error.exception.status_code, 404)

    def test_track_verification_returns_catalog_pair_for_exact_title(self) -> None:
        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="verify_tracks",
                arguments={"tracks": [{"title": " blue-train! ", "artist": "Someone else"}]},
            )
        )

        exact_title = next(
            row for row in response["rows"] if row["title"] == "Blue Train"
        )
        self.assertEqual(exact_title["artist"], "Alice")
        self.assertEqual(exact_title["candidate_artist_match"], 0)

    def test_track_verification_accepts_close_title_with_matching_artist(self) -> None:
        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="verify_tracks",
                arguments={"tracks": [{"title": "Blue Trane", "artist": "Alice"}]},
            )
        )

        match = next(
            row for row in response["rows"] if row["catalog_track_id"] == "t1"
        )
        self.assertGreaterEqual(match["title_similarity"], 0.60)
        self.assertGreaterEqual(match["artist_similarity"], 0.88)

    def test_track_verification_returns_close_title_candidates_for_artist_validation(self) -> None:
        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="verify_tracks",
                arguments={"tracks": [{"title": "Blue Trane", "artist": "Unrelated Artist"}]},
            )
        )

        match = next(
            row for row in response["rows"] if row["catalog_track_id"] == "t1"
        )
        self.assertGreaterEqual(match["title_similarity"], 0.60)
        self.assertLess(match["artist_similarity"], 0.65)

    def test_track_verification_returns_loose_title_candidates_for_artist_validation(self) -> None:
        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="verify_tracks",
                arguments={"tracks": [{"title": "B Trin", "artist": "Alice"}]},
            )
        )

        match = next(
            row for row in response["rows"] if row["catalog_track_id"] == "t1"
        )
        self.assertGreaterEqual(match["title_similarity"], 0.60)
        self.assertLess(match["title_similarity"], 0.68)
        self.assertEqual(match["candidate_artist_match"], 1)

    def test_track_verification_keeps_unicode_title_and_artist_characters(self) -> None:
        assert duckdb_service.connection is not None
        duckdb_service.connection.execute(
            "INSERT INTO tracks VALUES ('t-jp', 'カタカナ!', 180000, 1, 50, false, 4)"
        )
        duckdb_service.connection.execute(
            "INSERT INTO artists VALUES (4, '宇多田ヒカル', 'JP', 90)"
        )
        duckdb_service.connection.execute(
            "INSERT INTO track_artists VALUES ('t-jp', 4)"
        )

        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="verify_tracks",
                arguments={"tracks": [{"title": "カタカナ", "artist": "宇多田ヒカル"}]},
            )
        )

        self.assertEqual(len(response["rows"]), 1)
        self.assertEqual(response["rows"][0]["catalog_track_id"], "t-jp")

    def test_track_verification_prefers_matching_artist_for_duplicate_titles(self) -> None:
        assert duckdb_service.connection is not None
        duckdb_service.connection.execute(
            "INSERT INTO tracks VALUES ('t3', 'Blue Train', 600000, 1, 95, false, 3)"
        )
        duckdb_service.connection.execute(
            "INSERT INTO artists VALUES (3, 'John Coltrane', 'US', 90)"
        )
        duckdb_service.connection.execute("INSERT INTO track_artists VALUES ('t3', 3)")

        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="verify_tracks",
                arguments={"tracks": [{"title": "Blue Train", "artist": "John Coltrane"}]},
            )
        )

        self.assertEqual(response["rows"][0]["catalog_track_id"], "t3")
        self.assertEqual(response["rows"][0]["candidate_artist_match"], 1)

    def test_track_verification_searches_optional_musicbrainz_index(self) -> None:
        assert duckdb_service.connection is not None
        duckdb_service.connection.execute(
            """
            CREATE TABLE musicbrainz_recordings (
                recording_mbid VARCHAR,
                title VARCHAR,
                title_key VARCHAR,
                artist VARCHAR,
                duration_ms BIGINT
            )
            """
        )
        duckdb_service.connection.execute(
            "INSERT INTO musicbrainz_recordings VALUES "
            "('recording-1', 'Blue Train', 'bluetrain', 'John Coltrane', 640000)"
        )
        duckdb_service.musicbrainz_index_available = True

        response = duckdb_service.query_catalog(
            duckdb_service.CatalogToolRequest(
                tool="verify_tracks",
                arguments={"tracks": [{"title": "Blue Train", "artist": "John Coltrane"}]},
            )
        )

        musicbrainz_rows = [
            row for row in response["rows"] if row["source"] == "musicbrainz"
        ]
        self.assertEqual(len(musicbrainz_rows), 1)
        self.assertEqual(musicbrainz_rows[0]["catalog_track_id"], "mb:recording-1")
        self.assertEqual(musicbrainz_rows[0]["candidate_artist_match"], 1)

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
