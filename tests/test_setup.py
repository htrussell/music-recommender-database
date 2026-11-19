import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import setup


class UnifiedSetupTests(unittest.TestCase):
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
