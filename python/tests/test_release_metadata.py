from __future__ import annotations

import re
import unittest
from pathlib import Path

import coremind


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class ReleaseMetadataTest(unittest.TestCase):
    def test_public_version_matches_pyproject(self) -> None:
        pyproject = (REPOSITORY_ROOT / "python" / "pyproject.toml").read_text(
            encoding="utf-8"
        )
        match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
        self.assertIsNotNone(match)
        self.assertEqual(coremind.__version__, match.group(1))


if __name__ == "__main__":
    unittest.main()
