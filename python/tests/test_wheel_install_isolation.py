from __future__ import annotations

from contextlib import nullcontext
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("isolated_wheel_checker", ROOT / "scripts/check-python-wheel.py")
assert SPEC is not None and SPEC.loader is not None
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class InstallationChecked(Exception):
    pass


class WheelInstallIsolationTest(unittest.TestCase):
    def test_same_version_source_metadata_cannot_replace_venv_install(self) -> None:
        with tempfile.TemporaryDirectory(prefix="coremind-wheel-isolation-") as temporary:
            root = Path(temporary)
            source = root / "source"
            metadata = source / "coremind_ai.egg-info"
            metadata.mkdir(parents=True)
            package_metadata = "Metadata-Version: 2.1\nName: coremind-ai\nVersion: 1.2.0\n"
            (metadata / "PKG-INFO").write_text(package_metadata, encoding="utf-8")
            wheel = root / "coremind_ai-1.2.0-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("coremind/__init__.py", 'origin = "wheel"\n')
                archive.writestr("coremind_ai-1.2.0.dist-info/METADATA", package_metadata)
                archive.writestr("coremind_ai-1.2.0.dist-info/WHEEL",
                                 "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
                archive.writestr("coremind_ai-1.2.0.dist-info/RECORD", "")
            consumer = root / "consumer"
            consumer.mkdir()
            python = consumer / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

            def verify_before_server() -> int:
                # 在启动服务前验证真实安装结果；不模拟 venv、pip 或隔离导入。
                result = subprocess.run(
                    [str(python), "-I", "-X", "utf8", "-c",
                     "import coremind,sys; from pathlib import Path; "
                     "assert coremind.origin == 'wheel'; "
                     "assert Path(coremind.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())"],
                    capture_output=True, text=True, encoding="utf-8", check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                raise InstallationChecked()

            with patch.dict(os.environ, {"PYTHONPATH": str(source)}), \
                    patch.object(CHECKER.tempfile, "TemporaryDirectory", return_value=nullcontext(str(consumer))), \
                    patch.object(CHECKER, "free_port", side_effect=verify_before_server), \
                    self.assertRaises(InstallationChecked):
                CHECKER.smoke_install(wheel)


if __name__ == "__main__":
    unittest.main()
