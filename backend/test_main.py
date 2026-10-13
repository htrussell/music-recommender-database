import unittest
from unittest.mock import patch

from fastapi import HTTPException
import sqlglot

from main import AssistantRequest, assistant_json, call_ollama, validate_read_query


class ReadOnlyQueryValidationTests(unittest.TestCase):
    def test_allows_catalog_select_and_adds_row_limit(self) -> None:
        query = validate_read_query("SELECT track_id, track_name FROM tracks")

        self.assertIn("FROM tracks", query)
        self.assertIn("LIMIT 100", query)

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
            patch("main.query_music_catalog", return_value=[{"track_name": "Example"}]) as query,
        ):
            response = assistant_json(request)

        self.assertEqual(response, {"result": {"reply": "Try these tracks."}})
        query.assert_called_once_with("SELECT track_name FROM tracks")
        self.assertIn('"track_name": "Example"', ollama.call_args_list[1].args[1])

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

        self.assertEqual(response, {"result": {"reply": "Hello!"}})
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


if __name__ == "__main__":
    unittest.main()
