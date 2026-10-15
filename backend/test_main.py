import unittest
from unittest.mock import patch

from fastapi import HTTPException
import httpx
import sqlglot

from main import (
    AssistantRequest,
    CHAT_MODEL,
    EMBEDDING_MODEL,
    MODEL,
    SQL_MODEL,
    assistant_json,
    call_cloudflare_worker,
    clean_json,
    extract_youtube_playlist_id,
    fetch_catalog_for_request,
    generate_catalog_query,
    load_youtube_playlist,
    validate_read_query,
)


class ReadOnlyQueryValidationTests(unittest.TestCase):
    def test_cloudflare_models_are_assigned_to_the_expected_roles(self) -> None:
        self.assertEqual(MODEL, "llama")
        self.assertEqual(CHAT_MODEL, "glm")
        self.assertEqual(SQL_MODEL, "glm")
        self.assertEqual(EMBEDDING_MODEL, "nomic-embed-text:v1.5")

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
            "main.call_cloudflare_worker",
            side_effect=[
                {"sql": malformed_query},
                {"sql": "SELECT track_id FROM tracks"},
            ],
        ) as ollama:
            safe_query = generate_catalog_query("Recommend indie music; exclude country.")

        self.assertEqual(safe_query, "SELECT track_id FROM tracks LIMIT 100")
        self.assertEqual(ollama.call_count, 2)
        self.assertEqual(ollama.call_args_list[0].kwargs["model"], SQL_MODEL)
        self.assertEqual(ollama.call_args_list[1].kwargs["model"], SQL_MODEL)
        repair_request = ollama.call_args.args[1]
        self.assertIn(malformed_query, repair_request)
        self.assertIn("validation_error", repair_request)

    def test_repairs_query_that_does_not_read_from_catalog(self) -> None:
        with patch(
            "main.call_cloudflare_worker",
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
        with patch("main.call_cloudflare_worker", return_value={"sql": projection}) as ollama:
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
        with patch("main.call_cloudflare_worker", return_value={"sql": generated_query}):
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
        with patch("main.call_cloudflare_worker", return_value={"sql": generated_query}):
            safe_query = generate_catalog_query("Recommend indie tracks.")

        self.assertIn("genre.genre_name AS genre", safe_query)
        self.assertIn(
            "LEFT JOIN genre ON tracks.genre_id = genre.genre_id",
            safe_query,
        )

    def test_rebuilds_invalid_model_from_source_from_catalog_projection(self) -> None:
        generated_query = (
            "SELECT tracks.track_id AS catalog_track_id, tracks.track_name AS title, "
            "artists.artist_name AS artist FROM track_id"
        )
        with patch("main.call_cloudflare_worker", return_value={"sql": generated_query}) as ollama:
            safe_query = generate_catalog_query("Recommend indie tracks.")

        self.assertIn("FROM tracks", safe_query)
        self.assertIn(
            "LEFT JOIN track_artists ON tracks.track_id = track_artists.track_id",
            safe_query,
        )
        self.assertIn(
            "LEFT JOIN artists ON track_artists.artist_id = artists.artist_id",
            safe_query,
        )
        ollama.assert_called_once()

    def test_rejects_columns_not_present_in_catalog_schema(self) -> None:
        with self.assertRaises(HTTPException) as error:
            validate_read_query(
                "SELECT artist_genres.artist_country FROM artist_genres"
            )

        self.assertIn("not available", error.exception.detail)

    def test_rejects_query_if_model_correction_is_still_invalid(self) -> None:
        with (
            patch(
                "main.call_cloudflare_worker",
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
            patch(
                "main.call_cloudflare_worker",
                side_effect=[
                    {"tool": "search_tracks", "arguments": {"genre": "rock"}},
                    {"reply": "Try these tracks."},
                ],
            ) as ollama,
            patch(
                "main.query_duckdb_catalog",
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
        self.assertEqual(response["catalog_source"], "duckdb")
        query.assert_called_once_with("search_tracks", {"genre": "rock"})
        self.assertIn('"catalog_track_id": 42', ollama.call_args_list[1].args[1])
        self.assertIn("db:<catalog_track_id>", ollama.call_args_list[1].args[0])
        self.assertIn("search_tracks", ollama.call_args_list[0].args[0])
        self.assertEqual(ollama.call_args_list[0].kwargs["model"], SQL_MODEL)
        self.assertEqual(ollama.call_args_list[1].kwargs["model"], MODEL)

    def test_assistant_skips_catalog_query_for_small_talk(self) -> None:
        request = AssistantRequest(
            systemInstruction='Return JSON with a "reply" field.',
            userContent='CONVERSATION HISTORY:\nNo previous messages.\n\nNEW LISTENER MESSAGE:\n"hi"',
            task="chat",
        )
        with (
            patch("main.call_cloudflare_worker", return_value={"reply": "Hello!"}) as ollama,
            patch("main.query_music_catalog") as query,
            patch("main.query_duckdb_catalog") as duckdb_query,
        ):
            response = assistant_json(request)

        self.assertEqual(
            response,
            {"result": {"reply": "Hello!"}, "catalog": [], "catalog_source": "none"},
        )
        query.assert_not_called()
        duckdb_query.assert_not_called()
        ollama.assert_called_once()
        self.assertEqual(ollama.call_args.kwargs["model"], CHAT_MODEL)
        self.assertNotIn("MUSIC CATALOG", ollama.call_args.args[1])

    def test_uses_postgres_when_tool_plan_requests_fallback(self) -> None:
        with (
            patch(
                "main.call_cloudflare_worker",
                side_effect=[
                    {"tool": "postgres_fallback", "arguments": {"reason": "Needs a country filter."}},
                    {"sql": "SELECT track_name FROM tracks"},
                    {"reply": "Here are the results."},
                ],
            ),
            patch("main.query_music_catalog", return_value=[{"title": "Example"}]) as query,
            patch("main.query_duckdb_catalog") as duckdb_query,
        ):
            result = assistant_json(
                AssistantRequest(
                    systemInstruction="Return a JSON reply.",
                    userContent="Find songs by artists from a certain country.",
                )
            )

        self.assertEqual(result["catalog_source"], "postgres")
        query.assert_called_once_with("SELECT tracks.track_name FROM tracks LIMIT 100")
        duckdb_query.assert_not_called()

    def test_falls_back_to_postgres_if_duckdb_is_unavailable(self) -> None:
        with (
            patch(
                "main.call_cloudflare_worker",
                side_effect=[
                    {"tool": "search_tracks", "arguments": {"query": "blue train"}},
                    {"sql": "SELECT track_name FROM tracks"},
                    {"reply": "Here are the results."},
                ],
            ),
            patch(
                "main.query_duckdb_catalog",
                side_effect=HTTPException(status_code=503, detail="DuckDB is unavailable."),
            ),
            patch("main.query_music_catalog", return_value=[{"title": "Blue Train"}]) as query,
        ):
            result = assistant_json(
                AssistantRequest(
                    systemInstruction="Return a JSON reply.",
                    userContent="Find Blue Train.",
                )
            )

        self.assertEqual(result["catalog_source"], "postgres")
        query.assert_called_once_with("SELECT tracks.track_name FROM tracks LIMIT 100")

    def test_falls_back_to_postgres_when_duckdb_rejects_model_arguments(self) -> None:
        with (
            patch(
                "main.call_cloudflare_worker",
                side_effect=[
                    {"tool": "search_tracks", "arguments": {"query": "blue train"}},
                    {"sql": "SELECT track_name FROM tracks"},
                    {"reply": "Here are the results."},
                ],
            ),
            patch(
                "main.query_duckdb_catalog",
                side_effect=HTTPException(
                    status_code=422,
                    detail="DuckDB rejected the catalog-tool arguments: invalid limit.",
                ),
            ),
            patch("main.query_music_catalog", return_value=[{"title": "Blue Train"}]) as query,
        ):
            result = assistant_json(
                AssistantRequest(
                    systemInstruction="Return a JSON reply.",
                    userContent="Find Blue Train.",
                )
            )

        self.assertEqual(result["catalog_source"], "postgres")
        query.assert_called_once_with("SELECT tracks.track_name FROM tracks LIMIT 100")

    def test_empty_duckdb_results_do_not_trigger_unnecessary_postgres_fallback(self) -> None:
        with (
            patch(
                "main.generate_catalog_tool",
                return_value={"tool": "search_tracks", "arguments": {"query": "missing song"}},
            ),
            patch("main.query_duckdb_catalog", return_value=[]) as duckdb_query,
            patch("main.query_music_catalog") as postgres_query,
        ):
            rows, source = fetch_catalog_for_request("Find a missing song.")

        self.assertEqual(rows, [])
        self.assertEqual(source, "duckdb")
        duckdb_query.assert_called_once()
        postgres_query.assert_not_called()

    def test_skips_database_for_requests_that_need_no_catalog_facts(self) -> None:
        with (
            patch(
                "main.generate_catalog_tool",
                return_value={"tool": "no_catalog", "arguments": {}},
            ),
            patch("main.query_duckdb_catalog") as duckdb_query,
            patch("main.query_music_catalog") as postgres_query,
        ):
            rows, source = fetch_catalog_for_request("I like upbeat music.")

        self.assertEqual((rows, source), ([], "none"))
        duckdb_query.assert_not_called()
        postgres_query.assert_not_called()

    def test_active_queue_context_remains_available_without_catalog_results(self) -> None:
        queue_context = (
            'ACTIVE QUEUE ITEMS (authoritative): '
            '[{"title":"Stardust","artist":"Halsey","duration":3,"reason":"Matches the goal."}]'
        )
        with (
            patch(
                "main.generate_catalog_tool",
                return_value={"tool": "no_catalog", "arguments": {}},
            ),
            patch("main.call_cloudflare_worker", return_value={"reply": "Stardust by Halsey matches your goal."}) as ollama,
        ):
            response = assistant_json(
                AssistantRequest(
                    systemInstruction="You are the taste concierge.",
                    userContent=f"{queue_context}\nNEW LISTENER MESSAGE:\nTell me about the songs you recommended.",
                )
            )

        self.assertIn("Stardust", ollama.call_args.args[1])
        self.assertIn("must never be used to deny knowledge", ollama.call_args.args[0])
        self.assertEqual(response["catalog"], [])
        self.assertEqual(response["catalog_source"], "none")

    def test_cloudflare_worker_receives_model_and_chat_messages(self) -> None:
        with patch("main.httpx.post") as worker:
            worker.return_value.json.return_value = {"result": '{"reply":"Hello!"}'}
            result = call_cloudflare_worker("Return JSON.", "Say hello.")

        self.assertEqual(result, {"reply": "Hello!"})
        self.assertEqual(worker.call_args.kwargs["json"]["model"], MODEL)
        self.assertEqual(
            worker.call_args.kwargs["json"]["messages"],
            [
                {"role": "system", "content": "Return JSON."},
                {"role": "user", "content": "Say hello."},
            ],
        )
        self.assertIn("music-rec-ai.htrussell.workers.dev", worker.call_args.args[0])

    def test_clean_json_extracts_object_from_surrounding_prose(self) -> None:
        result = clean_json(
            'Here is the response you requested:\n```json\n{"reply":"Hello!"}\n```\n'
        )

        self.assertEqual(result, {"reply": "Hello!"})

    def test_clean_json_explains_non_json_response(self) -> None:
        with self.assertRaises(HTTPException) as error:
            clean_json("I cannot provide a JSON response.")

        self.assertEqual(error.exception.status_code, 502)
        self.assertIn("did not return a JSON object", error.exception.detail)

    def test_cloudflare_chat_model_receives_messages(self) -> None:
        with patch("main.httpx.post") as worker:
            worker.return_value.json.return_value = {"result": '{"reply":"Hello!"}'}
            result = call_cloudflare_worker(
                "Return JSON.",
                "Say hello.",
                model=CHAT_MODEL,
            )

        self.assertEqual(result, {"reply": "Hello!"})
        self.assertEqual(
            worker.call_args.kwargs["json"],
            {
                "model": CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": "Return JSON."},
                    {"role": "user", "content": "Say hello."},
                ],
            },
        )

    def test_cloudflare_worker_accepts_object_result(self) -> None:
        with patch("main.httpx.post") as worker:
            worker.return_value.json.return_value = {"result": {"reply": "Hello!"}}
            result = call_cloudflare_worker("Return JSON.", "Say hello.")

        self.assertEqual(result, {"reply": "Hello!"})

    def test_cloudflare_worker_parses_ai_response_field(self) -> None:
        with patch("main.httpx.post") as worker:
            worker.return_value.json.return_value = {
                "result": {"response": '{"reply":"Hello!"}'}
            }
            result = call_cloudflare_worker(
                "Return JSON.",
                "Say hello.",
                model=CHAT_MODEL,
            )

        self.assertEqual(result, {"reply": "Hello!"})

    def test_cloudflare_worker_parses_chat_completion_result(self) -> None:
        with patch("main.httpx.post") as worker:
            worker.return_value.json.return_value = {
                "result": {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": '```json\n{"reply":"Hello!"}\n```',
                            }
                        }
                    ]
                }
            }
            result = call_cloudflare_worker(
                "Return JSON.",
                "Say hello.",
                model=CHAT_MODEL,
            )

        self.assertEqual(result, {"reply": "Hello!"})

    def test_cloudflare_chat_allows_plain_text_as_reply(self) -> None:
        with patch("main.httpx.post") as worker:
            worker.return_value.json.return_value = {
                "result": {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "Hello! How can I assist you today?",
                            }
                        }
                    ]
                }
            }
            result = call_cloudflare_worker(
                "Return a JSON response.",
                "Say hello.",
                model=CHAT_MODEL,
                allow_plain_text=True,
            )

        self.assertEqual(
            result,
            {
                "reply": "Hello! How can I assist you today?",
                "extracted_taste_insights": [],
                "suggested_recommender_action": None,
            },
        )

    def test_cloudflare_worker_surfaces_provider_error_details(self) -> None:
        response = httpx.Response(
            500,
            json={
                "error": "Internal Server Error",
                "details": "Expected property name or '}' in JSON at position 7",
            },
            request=httpx.Request("POST", "https://worker.example"),
        )
        with patch("main.httpx.post", return_value=response):
            with self.assertRaises(HTTPException) as error:
                call_cloudflare_worker("Return JSON.", "Say hello.")

        self.assertEqual(error.exception.status_code, 502)
        self.assertIn("Expected property name", error.exception.detail)

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
