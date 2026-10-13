import unittest
from unittest.mock import patch

from fastapi import HTTPException
import sqlglot

from main import (
    AssistantRequest,
    assistant_json,
    call_ollama,
    extract_youtube_playlist_id,
    generate_catalog_query,
    load_youtube_playlist,
    validate_read_query,
)


class ReadOnlyQueryValidationTests(unittest.TestCase):
    def test_allows_catalog_select_and_adds_row_limit(self) -> None:
        query = validate_read_query("SELECT track_id, track_name FROM tracks")

        self.assertIn("FROM tracks", query)
        self.assertIn("LIMIT 100", query)

    def test_allows_partial_name_matching_for_catalog_queries(self) -> None:
        query = validate_read_query(
            "SELECT tracks.track_id AS catalog_track_id, tracks.track_name AS title "
            "FROM tracks WHERE tracks.track_name ILIKE '%blue%train%' "
            "AND tracks.duration_ms <= 1800000"
        )

        self.assertIn("ILIKE", query)
        self.assertIn("AND", query)

    def test_repairs_invalid_model_sql_before_catalog_execution(self) -> None:
        malformed_query = "SELECT FROM tracks WHERE EXCLUDE 'country, holiday music'"
        with patch(
            "main.call_ollama",
            side_effect=[
                {"sql": malformed_query},
                {"sql": "SELECT track_id FROM tracks"},
            ],
        ) as ollama:
            safe_query = generate_catalog_query("Recommend indie music; exclude country.")

        self.assertEqual(safe_query, "SELECT track_id FROM tracks LIMIT 100")
        self.assertEqual(ollama.call_count, 2)
        repair_request = ollama.call_args.args[1]
        self.assertIn(malformed_query, repair_request)
        self.assertIn("validation_error", repair_request)

    def test_repairs_query_that_does_not_read_from_catalog(self) -> None:
        with patch(
            "main.call_ollama",
            side_effect=[
                {"sql": "SELECT 'indie and alternative'"},
                {"sql": "SELECT tracks.track_id, tracks.track_name FROM tracks"},
            ],
        ) as ollama:
            safe_query = generate_catalog_query(
                "Find new indie and alternative music with atmospheric guitars and thoughtful lyrics."
            )

        self.assertEqual(
            safe_query,
            "SELECT tracks.track_id, tracks.track_name FROM tracks LIMIT 100",
        )
        repair_instruction = ollama.call_args.args[0]
        self.assertIn("omitted its FROM clause", repair_instruction)
        self.assertIn("FROM tracks", repair_instruction)

    def test_completes_model_catalog_projection_missing_from_clause(self) -> None:
        projection = (
            "SELECT tracks.track_id AS catalog_track_id, tracks.track_name AS title, "
            "artists.artist_name AS artist, tracks.duration_ms, genre.genre_name AS genre, "
            "track_feel.energy AS energy"
        )
        with patch("main.call_ollama", return_value={"sql": projection}) as ollama:
            safe_query = generate_catalog_query("Recommend indie music with atmospheric guitars.")

        self.assertIn("FROM tracks", safe_query)
        self.assertIn("LEFT JOIN artists", safe_query)
        self.assertIn("LEFT JOIN genre", safe_query)
        self.assertIn("LEFT JOIN track_feel", safe_query)
        self.assertIn("LIMIT 100", safe_query)
        ollama.assert_called_once()

    def test_replaces_invalid_direct_artist_join_with_catalog_relationship(self) -> None:
        generated_query = (
            "SELECT tracks.track_id AS catalog_track_id, tracks.track_name AS title, "
            "artists.artist_name AS artist FROM tracks "
            "JOIN artists ON tracks.artist_id = artists.artist_id"
        )
        with patch("main.call_ollama", return_value={"sql": generated_query}):
            safe_query = generate_catalog_query("Recommend indie tracks.")

        self.assertIn(
            "LEFT JOIN track_artists ON tracks.track_id = track_artists.track_id",
            safe_query,
        )
        self.assertIn(
            "LEFT JOIN artists ON track_artists.artist_id = artists.artist_id",
            safe_query,
        )
        self.assertNotIn("tracks.artist_id", safe_query)

    def test_qualifies_unambiguous_catalog_columns_before_joining(self) -> None:
        generated_query = (
            "SELECT tracks.track_id AS catalog_track_id, tracks.track_name AS title, "
            "genre_name AS genre FROM tracks"
        )
        with patch("main.call_ollama", return_value={"sql": generated_query}):
            safe_query = generate_catalog_query("Recommend indie tracks.")

        self.assertIn("genre.genre_name AS genre", safe_query)
        self.assertIn(
            "LEFT JOIN genre ON tracks.genre_id = genre.genre_id",
            safe_query,
        )

    def test_rejects_query_if_model_correction_is_still_invalid(self) -> None:
        with (
            patch(
                "main.call_ollama",
                side_effect=[
                    {"sql": "SELECT track_id FROM secret_table"},
                    {"sql": "DELETE FROM tracks"},
                ],
            ),
            self.assertRaises(HTTPException) as error,
        ):
            generate_catalog_query("Recommend some music.")

        self.assertEqual(error.exception.status_code, 502)

    def test_caps_large_limits(self) -> None:
        query = validate_read_query("SELECT track_name FROM tracks LIMIT 5000")
        parsed = sqlglot.parse_one(query, read="postgres")

        self.assertEqual(parsed.args["limit"].expression.this, "100")

    def test_rejects_data_modification(self) -> None:
        with self.assertRaises(HTTPException):
            validate_read_query("DELETE FROM tracks")

    def test_rejects_multiple_statements(self) -> None:
        with self.assertRaises(HTTPException):
            validate_read_query("SELECT track_id FROM tracks; DROP TABLE tracks")

    def test_rejects_non_music_tables(self) -> None:
        with self.assertRaises(HTTPException):
            validate_read_query("SELECT * FROM information_schema.tables")

    def test_rejects_unsafe_functions(self) -> None:
        with self.assertRaises(HTTPException):
            validate_read_query("SELECT pg_sleep(10) FROM tracks")

    def test_rejects_non_numeric_limits(self) -> None:
        with self.assertRaises(HTTPException):
            validate_read_query("SELECT track_id FROM tracks LIMIT ALL")

    def test_assistant_uses_catalog_rows_before_final_response(self) -> None:
        request = AssistantRequest(
            systemInstruction='Return JSON with a "reply" field.',
            userContent="Recommend energetic rock tracks.",
        )
        with (
            patch("main.call_ollama", side_effect=[{"sql": "SELECT track_name FROM tracks"}, {"reply": "Try these tracks."}]) as ollama,
            patch(
                "main.query_music_catalog",
                return_value=[
                    {
                        "catalog_track_id": 42,
                        "title": "Example",
                        "artist": "Example artist",
                        "duration_ms": 180000,
                        "energy": 0.8,
                    }
                ],
            ) as query,
        ):
            response = assistant_json(request)

        self.assertEqual(response["result"], {"reply": "Try these tracks."})
        self.assertEqual(response["catalog"][0]["catalog_track_id"], 42)
        query.assert_called_once_with("SELECT tracks.track_name FROM tracks LIMIT 100")
        self.assertIn('"catalog_track_id": 42', ollama.call_args_list[1].args[1])
        self.assertIn("db:<catalog_track_id>", ollama.call_args_list[1].args[0])
        self.assertIn("spelling variations", ollama.call_args_list[0].args[0])

    def test_assistant_skips_catalog_query_for_small_talk(self) -> None:
        request = AssistantRequest(
            systemInstruction='Return JSON with a "reply" field.',
            userContent='CONVERSATION HISTORY:\nNo previous messages.\n\nNEW LISTENER MESSAGE:\n"hi"',
        )
        with (
            patch("main.call_ollama", return_value={"reply": "Hello!"}) as ollama,
            patch("main.query_music_catalog") as query,
        ):
            response = assistant_json(request)

        self.assertEqual(response, {"result": {"reply": "Hello!"}, "catalog": []})
        query.assert_not_called()
        ollama.assert_called_once()
        self.assertNotIn("MUSIC CATALOG", ollama.call_args.args[1])

    def test_ollama_reasoning_is_disabled_for_json_responses(self) -> None:
        with patch("main.httpx.post") as ollama:
            ollama.return_value.json.return_value = {
                "message": {"content": '{"reply":"Hello!"}'}
            }
            result = call_ollama("Return JSON.", "Say hello.")

        self.assertEqual(result, {"reply": "Hello!"})
        self.assertFalse(ollama.call_args.kwargs["json"]["think"])

    def test_extracts_only_youtube_playlist_ids(self) -> None:
        self.assertEqual(
            extract_youtube_playlist_id("https://www.youtube.com/playlist?list=PLabcdefghij"),
            "PLabcdefghij",
        )
        self.assertEqual(extract_youtube_playlist_id("PLabcdefghij"), "PLabcdefghij")
        with self.assertRaises(HTTPException):
            extract_youtube_playlist_id("https://example.com/playlist?list=PLabcdefghij")

    def test_loads_public_youtube_playlist_without_credentials(self) -> None:
        playlist_info = {
            "title": "Example playlist",
            "entries": [
                {
                    "id": "video123",
                    "title": "Example song",
                    "channel": "Example artist",
                    "duration": 185,
                    "thumbnail": "https://i.ytimg.com/vi/video123/default.jpg",
                }
            ],
        }
        with patch("main.yt_dlp.YoutubeDL") as youtube_dl:
            youtube_dl.return_value.__enter__.return_value.extract_info.return_value = playlist_info

            playlist = load_youtube_playlist("PLabcdefghij")

        self.assertEqual(playlist["playlistName"], "Example playlist")
        self.assertEqual(playlist["tracks"][0]["artist"], "Example artist")
        self.assertEqual(playlist["tracks"][0]["durationSeconds"], 185)
        options = youtube_dl.call_args.args[0]
        self.assertEqual(options["extract_flat"], "in_playlist")
        self.assertNotIn("cookiefile", options)


if __name__ == "__main__":
    unittest.main()
