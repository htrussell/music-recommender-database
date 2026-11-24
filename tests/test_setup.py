import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import setup


class UnifiedSetupTests(unittest.TestCase):
    def test_interactive_youtube_key_preserves_existing_env_settings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env_file = root / ".env"
            env_file.write_text("OTHER_SETTING=value\nexport YOUTUBE_API_KEY=old\n", encoding="utf-8")
            with (
                patch.object(setup, "ROOT_DIR", root),
                patch.dict(os.environ, {"YOUTUBE_API_KEY": ""}),
                patch("builtins.input", return_value="y"),
                patch("getpass.getpass", return_value="new-key_123"),
            ):
                setup.configure_youtube_api_key(non_interactive=False)

            self.assertEqual(
                env_file.read_text(encoding="utf-8"),
                "OTHER_SETTING=value\nYOUTUBE_API_KEY=new-key_123\n",
            )

    def test_interactive_youtube_key_creates_private_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with (
                patch.object(setup, "ROOT_DIR", root),
                patch.dict(os.environ, {"YOUTUBE_API_KEY": ""}),
                patch("builtins.input", return_value="y"),
                patch("getpass.getpass", return_value="test-key"),
            ):
                setup.configure_youtube_api_key(non_interactive=False)

            env_file = root / ".env"
            self.assertEqual(env_file.read_text(encoding="utf-8"), "YOUTUBE_API_KEY=test-key\n")
            if os.name != "nt":
                self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)

    def test_youtube_key_is_optional_and_noninteractive_does_not_modify_env(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env_file = root / ".env"
            env_file.write_text("YOUTUBE_API_KEY=existing\n", encoding="utf-8")
            with (
                patch.object(setup, "ROOT_DIR", root),
                patch.dict(os.environ, {"YOUTUBE_API_KEY": ""}),
                patch("builtins.input", return_value="n") as prompt,
                patch("getpass.getpass") as secret_prompt,
            ):
                setup.configure_youtube_api_key(non_interactive=True)
                prompt.assert_not_called()
                setup.configure_youtube_api_key(non_interactive=False)
                secret_prompt.assert_not_called()
            self.assertEqual(env_file.read_text(encoding="utf-8"), "YOUTUBE_API_KEY=existing\n")

    def test_invalid_youtube_key_does_not_modify_env(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with (
                patch.object(setup, "ROOT_DIR", root),
                patch.dict(os.environ, {"YOUTUBE_API_KEY": ""}),
                patch("builtins.input", return_value="y"),
                patch("getpass.getpass", return_value="bad\nOTHER=value"),
            ):
                with self.assertRaises(setup.SetupError):
                    setup.configure_youtube_api_key(non_interactive=False)
            self.assertFalse((root / ".env").exists())

    def test_youtube_key_in_environment_skips_interactive_prompt(self) -> None:
        with (
            patch.dict(os.environ, {"YOUTUBE_API_KEY": "configured"}),
            patch("builtins.input") as prompt,
        ):
            setup.configure_youtube_api_key(non_interactive=False)
        prompt.assert_not_called()

    def test_write_kaggle_credentials_restricts_unix_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"KAGGLE_CONFIG_DIR": temporary}, clear=False):
                credentials = setup.write_kaggle_credentials("listener", "secret")

            self.assertTrue(credentials.is_file())
            if os.name != "nt":
                self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)

    def test_parse_args_supports_unified_semantic_modes(self) -> None:
        with patch(
            "sys.argv",
            [
                "setup.py",
                "--download",
                "reuse-csv",
                "--semantic",
                "subset",
                "--embedding-limit",
                "32",
                "--yes",
                "--start",
            ],
        ):
            args = setup.parse_args()

        self.assertEqual(args.download, "reuse-csv")
        self.assertEqual(args.semantic, "subset")
        self.assertEqual(args.embedding_limit, 32)
        self.assertTrue(args.yes)
        self.assertTrue(args.start)

    def test_require_source_csvs_reports_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            old_root = setup.ROOT_DIR
            setup.ROOT_DIR = Path(temporary)
            try:
                with self.assertRaises(setup.SetupError) as error:
                    setup.require_source_csvs()
            finally:
                setup.ROOT_DIR = old_root

        self.assertIn("Missing source CSV files", str(error.exception))


if __name__ == "__main__":
    unittest.main()
