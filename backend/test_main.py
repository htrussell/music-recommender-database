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
    TrackIdentity,
    TrackVerificationRequest,
    assistant_json,
    call_cloudflare_worker,
    clean_json,
    extract_youtube_playlist_id,
    fetch_catalog_for_request,
    generate_catalog_query,
    load_demo_profile,
    load_youtube_playlist,
    verify_discovered_tracks,
    validate_read_query,
)


class ReadOnlyQueryValidationTests(unittest.TestCase):
    def test_demo_profile_endpoint_rejects_non_positive_ids(self) -> None:
        with self.assertRaises(HTTPException) as error:
            load_demo_profile(0)

        self.assertEqual(error.exception.status_code, 422)

    def test_demo_profile_endpoint_proxies_profile_and_catalog_matches(self) -> None:
        payload = {
            "profile": {"listener_id": 1, "top_artist": "Alice"},
            "artist_mapping_status": "matched",
            "genre_mapping_status": "matched",
            "matched_genre": {"genre_id": 1, "genre_name": "Jazz"},
            "tracks": [{"catalog_track_id": "t1", "title": "Blue Train"}],
        }
        response = httpx.Response(
            200,
            json=payload,
            request=httpx.Request("GET", "http://duckdb/demo-profiles/1"),
        )
        with patch("main.httpx.get", return_value=response) as duckdb_request:
            result = load_demo_profile(1)

        self.assertEqual(result, payload)
        self.assertEqual(
            duckdb_request.call_args.args[0],
            "http://duckdb:8001/demo-profiles/1",
        )

    def test_demo_profile_endpoint_preserves_unknown_id_response(self) -> None:
        response = httpx.Response(
            404,
            json={"detail": "Demo listener 5000 was not found."},
            request=httpx.Request("GET", "http://duckdb/demo-profiles/5000"),
        )
        with patch("main.httpx.get", return_value=response):
            with self.assertRaises(HTTPException) as error:
                load_demo_profile(5000)

        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(error.exception.detail, "Demo listener 5000 was not found.")

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
        self.assertEqual(ollama.call_args_list[0].kwargs["max_tokens"], 384)
        self.assertEqual(ollama.call_args_list[1].kwargs["model"], MODEL)
        self.assertEqual(ollama.call_args_list[1].kwargs["max_tokens"], 1200)

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
        self.assertEqual(ollama.call_args.kwargs["max_tokens"], 512)
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
        self.assertEqual(worker.call_args.kwargs["json"]["max_tokens"], 1024)
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
                "max_tokens": 1024,
                "messages": [
                    {"role": "system", "content": "Return JSON."},
                    {"role": "user", "content": "Say hello."},
                ],
            },
        )

    def test_discovery_task_skips_catalog_planning_and_uses_discovery_token_limit(self) -> None:
        request = AssistantRequest(
            systemInstruction='Return JSON with a "tracks" array.',
            userContent='Goal: "ambient music for reading"; Target Duration: 30 minutes',
            task="discovery",
        )
        with (
            patch("main.call_cloudflare_worker", return_value={"tracks": []}) as worker,
            patch("main.fetch_catalog_for_request") as catalog,
        ):
            response = assistant_json(request)

        self.assertEqual(response["result"], {"tracks": []})
        self.assertEqual(response["catalog"], [])
        self.assertEqual(response["catalog_source"], "none")
        catalog.assert_not_called()
        worker.assert_called_once()
        self.assertEqual(worker.call_args.kwargs["model"], MODEL)
        self.assertEqual(worker.call_args.kwargs["max_tokens"], 1400)

    def test_playlist_recommendation_skips_redundant_catalog_planning(self) -> None:
        request = AssistantRequest(
            systemInstruction='Return JSON with a "recommendations" array.',
            userContent="CANDIDATE POOL (Compact Format):\nID: playlist:1 | Sample - Artist",
            task="recommendation",
            skipCatalog=True,
        )
        with (
            patch("main.fetch_catalog_for_request") as catalog,
            patch(
                "main.call_cloudflare_worker",
                return_value={"recommendations": []},
            ) as worker,
        ):
            response = assistant_json(request)

        self.assertEqual(response["result"], {"recommendations": []})
        self.assertEqual(response["catalog"], [])
        self.assertEqual(response["catalog_source"], "none")
        catalog.assert_not_called()
        worker.assert_called_once()
        self.assertEqual(worker.call_args.kwargs["model"], MODEL)

    def test_discovered_track_verification_corrects_single_catalog_match(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": 17,
                    "title": "Harvey",
                    "artist": "Alex G",
                    "duration_ms": 210000,
                    "genre": "Indie",
                    "candidate_artist_match": 0,
                    "title_similarity": 1.0,
                    "artist_similarity": 0.2,
                }
            ],
        ) as query:
            result = verify_discovered_tracks(
                TrackVerificationRequest(tracks=[TrackIdentity(title="Harvey", artist="Tyler, The Creator")])
            )

        self.assertEqual(
            result["tracks"],
            [
                {
                    "catalog_track_id": 17,
                    "title": "Harvey",
                    "artist": "Alex G",
                    "duration_ms": 210000,
                    "genre": "Indie",
                    "candidate_index": 0,
                    "artist_corrected": True,
                    "source": "primary",
                }
            ],
        )
        query.assert_called_once()

    def test_discovered_track_verification_uses_best_candidate_for_ambiguous_title(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {"candidate_index": 0, "catalog_track_id": 1, "title": "Young", "artist": "Artist A", "candidate_artist_match": 0, "title_similarity": 1.0, "artist_similarity": 0.2, "popularity": 20},
                {"candidate_index": 0, "catalog_track_id": 2, "title": "Young", "artist": "Artist B", "candidate_artist_match": 0, "title_similarity": 1.0, "artist_similarity": 0.4, "popularity": 10},
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(tracks=[TrackIdentity(title="Young", artist="Unknown Artist")])
            )

        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["tracks"][0]["catalog_track_id"], 2)

    def test_discovered_track_verification_uses_exact_musicbrainz_artist(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": "local-1",
                    "title": "Blue Train",
                    "artist": "Other Artist",
                    "candidate_artist_match": 0,
                    "source": "primary",
                },
                {
                    "candidate_index": 0,
                    "catalog_track_id": "mb:recording-1",
                    "title": "Blue Train",
                    "artist": "John Coltrane",
                    "duration_ms": 640000,
                    "candidate_artist_match": 1,
                    "source": "musicbrainz",
                },
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(
                    tracks=[TrackIdentity(title="Blue Train", artist="John Coltrane")]
                )
            )

        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["tracks"][0]["catalog_track_id"], "mb:recording-1")
        self.assertFalse(result["tracks"][0]["artist_corrected"])
        self.assertEqual(result["tracks"][0]["source"], "musicbrainz")

    def test_discovered_track_verification_accepts_close_title_and_artist_matches(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": "track-1",
                    "title": "Blue Train",
                    "artist": "Alice",
                    "candidate_artist_match": 0,
                    "title_similarity": 0.94,
                    "artist_similarity": 0.96,
                    "source": "primary",
                }
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(
                    tracks=[TrackIdentity(title="Blue Trane", artist="Alyce")]
                )
            )

        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["tracks"][0]["catalog_track_id"], "track-1")
        self.assertTrue(result["tracks"][0]["artist_corrected"])

    def test_discovered_track_verification_allows_strong_unique_title_with_wrong_artist(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": "track-1",
                    "title": "Blue Train",
                    "artist": "Alice",
                    "candidate_artist_match": 0,
                    "title_similarity": 0.94,
                    "artist_similarity": 0.12,
                    "source": "primary",
                }
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(
                    tracks=[TrackIdentity(title="Blue Trane", artist="Unknown Artist")]
                )
            )

        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["tracks"][0]["catalog_track_id"], "track-1")
        self.assertTrue(result["tracks"][0]["artist_corrected"])

    def test_discovered_track_verification_rejects_weak_title_and_artist_match(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": "track-1",
                    "title": "A Different Song",
                    "artist": "Another Artist",
                    "candidate_artist_match": 0,
                    "title_similarity": 0.66,
                    "artist_similarity": 0.2,
                }
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(
                    tracks=[TrackIdentity(title="Requested Song", artist="Requested Artist")]
                )
            )

        self.assertEqual(result["tracks"], [])

    def test_discovered_track_verification_selects_best_ambiguous_fuzzy_candidate(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": "track-1",
                    "title": "Blue Train",
                    "artist": "Alice",
                    "candidate_artist_match": 0,
                    "title_similarity": 0.94,
                    "artist_similarity": 0.94,
                },
                {
                    "candidate_index": 0,
                    "catalog_track_id": "track-2",
                    "title": "Blue Trane",
                    "artist": "Alyce",
                    "candidate_artist_match": 0,
                    "title_similarity": 0.95,
                    "artist_similarity": 0.95,
                },
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(
                    tracks=[TrackIdentity(title="Blue Trains", artist="Alycee")]
                )
            )

        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["tracks"][0]["catalog_track_id"], "track-2")

    def test_discovered_track_verification_accepts_loose_title_match_with_wrong_artist(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": "track-1",
                    "title": "Blue Train",
                    "artist": "Alice",
                    "candidate_artist_match": 0,
                    "title_similarity": 0.83,
                    "artist_similarity": 0.12,
                }
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(
                    tracks=[TrackIdentity(title="Blue Trains", artist="Unknown Artist")]
                )
            )

        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["tracks"][0]["catalog_track_id"], "track-1")

    def test_discovered_track_verification_accepts_low_title_similarity_with_exact_artist(self) -> None:
        with patch(
            "main.query_duckdb_catalog",
            return_value=[
                {
                    "candidate_index": 0,
                    "catalog_track_id": "track-1",
                    "title": "Blue Train",
                    "artist": "Alice",
                    "candidate_artist_match": 1,
                    "title_similarity": 0.64,
                    "artist_similarity": 1.0,
                }
            ],
        ):
            result = verify_discovered_tracks(
                TrackVerificationRequest(
                    tracks=[TrackIdentity(title="B Trin", artist="Alice")]
                )
            )

        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["tracks"][0]["catalog_track_id"], "track-1")

    def test_chat_retries_with_recommendation_model_when_completion_is_empty(self) -> None:
        request = AssistantRequest(
            systemInstruction="Return a conversational JSON reply.",
            userContent="What kind of music might fit my goal?",
            task="chat",
        )
        with (
            patch("main.fetch_catalog_for_request", return_value=([], "none")),
            patch(
                "main.call_cloudflare_worker",
                side_effect=[
                    HTTPException(
                        status_code=502,
                        detail="Cloudflare AI Worker returned a completion without message content.",
                    ),
                    {
                        "reply": "Let’s explore a few styles that fit your goal.",
                        "extracted_taste_insights": [],
                        "suggested_recommender_action": None,
                    },
                ],
            ) as worker,
        ):
            response = assistant_json(request)

        self.assertIn("explore", response["result"]["reply"])
        self.assertEqual(worker.call_count, 2)
        self.assertEqual(worker.call_args_list[0].kwargs["model"], CHAT_MODEL)
        self.assertEqual(worker.call_args_list[1].kwargs["model"], MODEL)

    def test_recommendation_retries_with_chat_model_when_completion_is_empty(self) -> None:
        request = AssistantRequest(
            systemInstruction="Return playlist recommendations as JSON.",
            userContent="Recommend songs for a calm evening.",
            task="recommendation",
        )
        with (
            patch("main.fetch_catalog_for_request", return_value=([], "none")),
            patch(
                "main.call_cloudflare_worker",
                side_effect=[
                    HTTPException(
                        status_code=502,
                        detail="Cloudflare AI Worker returned a completion without message content.",
                    ),
                    {"recommendations": []},
                ],
            ) as worker,
        ):
            response = assistant_json(request)

        self.assertEqual(response["result"], {"recommendations": []})
        self.assertEqual(worker.call_count, 2)
        self.assertEqual(worker.call_args_list[0].kwargs["model"], MODEL)
        self.assertEqual(worker.call_args_list[1].kwargs["model"], CHAT_MODEL)
        self.assertEqual(worker.call_args_list[1].kwargs["max_tokens"], 1200)
        self.assertFalse(worker.call_args_list[1].kwargs["allow_plain_text"])

    def test_recommendation_retries_with_strict_json_instruction_on_invalid_json(self) -> None:
        request = AssistantRequest(
            systemInstruction='Return playlist recommendations as JSON with a "recommendations" array.',
            userContent="Recommend songs for a calm evening.",
            task="recommendation",
        )
        invalid_json = HTTPException(
            status_code=502,
            detail="AI provider did not return a JSON object. Response began: 'Here are some songs'",
        )
        with (
            patch("main.fetch_catalog_for_request", return_value=([], "none")),
            patch(
                "main.call_cloudflare_worker",
                side_effect=[invalid_json, {"recommendations": []}],
            ) as worker,
        ):
            response = assistant_json(request)

        self.assertEqual(response["result"], {"recommendations": []})
        self.assertEqual(worker.call_count, 2)
        self.assertEqual(worker.call_args_list[0].kwargs["model"], MODEL)
        self.assertEqual(worker.call_args_list[1].kwargs["model"], CHAT_MODEL)
        self.assertIn("previous model did not return a valid JSON object", worker.call_args_list[1].args[0])

    def test_empty_completions_from_every_worker_model_return_clear_error(self) -> None:
        request = AssistantRequest(
            systemInstruction="Return playlist recommendations as JSON.",
            userContent="Recommend songs for a calm evening.",
            task="recommendation",
        )
        empty_completion = HTTPException(
            status_code=502,
            detail="Cloudflare AI Worker returned a completion without message content.",
        )
        with (
            patch("main.fetch_catalog_for_request", return_value=([], "none")),
            patch(
                "main.call_cloudflare_worker",
                side_effect=[empty_completion, empty_completion],
            ) as worker,
        ):
            with self.assertRaises(HTTPException) as error:
                assistant_json(request)

        self.assertIn("all tried models: llama, glm", error.exception.detail)
        self.assertEqual(
            [call.kwargs["model"] for call in worker.call_args_list],
            [MODEL, CHAT_MODEL],
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

    def test_cloudflare_chat_surfaces_empty_completion_for_model_fallback(self) -> None:
        with patch("main.httpx.post") as worker:
            worker.return_value.json.return_value = {
                "result": {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "reasoning": "Internal reasoning is not a user-facing reply.",
                            }
                        }
                    ]
                }
            }
            with self.assertRaises(HTTPException) as error:
                call_cloudflare_worker(
                    "Return a JSON response.",
                    "Say hello.",
                    model=CHAT_MODEL,
                    allow_plain_text=True,
                )

        self.assertEqual(error.exception.status_code, 502)
        self.assertIn("without message content", error.exception.detail)

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
