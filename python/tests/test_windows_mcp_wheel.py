from __future__ import annotations

import importlib.util
import io
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("windows_mcp_wheel_checker", ROOT / "scripts/check-python-wheel.py")
assert SPEC is not None and SPEC.loader is not None
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)
PREFIX = "coremind/_worker/vendor/windows-mcp/"


class WindowsMcpWheelTest(unittest.TestCase):
    def test_frozen_assets_pass_and_missing_or_forged_assets_fail(self) -> None:
        vendor = ROOT / "packages/coremind-tools/src/vendor/windows-mcp"
        files = {name: (vendor / name).read_bytes() for name in
                 ("service.mjs", "manifest.json", "metafile.json", "THIRD-PARTY-LICENSES.txt")}

        def check(assets: dict[str, bytes]) -> list[str]:
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                for name, content in assets.items():
                    archive.writestr(PREFIX + name, content)
            with zipfile.ZipFile(buffer) as archive:
                return CHECKER.check_windows_mcp_assets(archive)

        self.assertEqual(check(files), [])
        for name in files:
            with self.subTest(name=name):
                self.assertTrue(check({key: value for key, value in files.items() if key != name}))
                self.assertTrue(check({**files, name: b"replacement"}))
        self.assertTrue(check({**files, "extra.mjs": b"process.exit(0)"}))


if __name__ == "__main__":
    unittest.main()
