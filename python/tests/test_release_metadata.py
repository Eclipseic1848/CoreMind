from __future__ import annotations

import re
import hashlib
import json
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

    def test_pyproject_declares_production_stable_maturity(self) -> None:
        pyproject = (REPOSITORY_ROOT / "python" / "pyproject.toml").read_text(
            encoding="utf-8"
        )
        self.assertIn("Development Status :: 5 - Production/Stable", pyproject)
        self.assertNotIn("Development Status :: 4 - Beta", pyproject)

    def test_bundled_worker_manifest_matches_sdk_and_bundle(self) -> None:
        package_root = REPOSITORY_ROOT / "python" / "src" / "coremind"
        worker = package_root / "_worker" / "coremind-worker.mjs"
        manifest = json.loads(
            (package_root / "_worker" / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["version"], coremind.__version__)
        self.assertEqual(manifest["protocolVersion"], "1.0")
        self.assertEqual(manifest["protocolV2Version"], "2.0")
        self.assertRegex(
            manifest["protocolV2SchemaFingerprint"], r"^sha256:[0-9a-f]{64}$"
        )
        self.assertEqual(
            manifest["bundleSha256"], hashlib.sha256(worker.read_bytes()).hexdigest()
        )

    def test_bundled_worker_preserves_required_license(self) -> None:
        source = (REPOSITORY_ROOT / "packages" / "coremind-runtime" / "src" / "session-v4" / "index.ts").read_text(
            encoding="utf-8"
        )
        notice = source.partition("/*!")[2].partition("*/")[0]
        self.assertIn("Copyright (c) 2025 Mario Zechner", notice)
        bundle = (REPOSITORY_ROOT / "python" / "src" / "coremind" / "_worker" / "coremind-worker.mjs").read_text(
            encoding="utf-8"
        )
        self.assertIn(" ".join(notice.split()), " ".join(bundle.split()))


if __name__ == "__main__":
    unittest.main()
