from __future__ import annotations

import importlib.util
import io
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("skill_wheel_checker", ROOT / "scripts" / "check-python-wheel.py")
assert SPEC is not None and SPEC.loader is not None
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)
PREFIX = "coremind/skills/"
ASSETS = {"legacy/README.md": "保留旧技能\n".encode("utf-8"),
          "standard/SKILL.md": "---\nname: 标准技能\ndescription: 描述\n---\n正文🙂\n".encode("utf-8")}


class SkillAssetsWheelTest(unittest.TestCase):
    def check(self, packed: list[tuple[str, bytes]]) -> list[str]:
        with tempfile.TemporaryDirectory(prefix="coremind-skill-assets-") as temporary:
            source = Path(temporary)
            for name, content in ASSETS.items():
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive, warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                for name, content in packed:
                    archive.writestr(PREFIX + name, content)
            with zipfile.ZipFile(buffer) as archive:
                return CHECKER.check_skill_assets(archive, source)

    def test_readme_and_standard_assets_match_exact_bytes(self) -> None:
        self.assertEqual(self.check(list(ASSETS.items())), [])

    def test_missing_legacy_or_standard_asset_is_rejected(self) -> None:
        for missing in ASSETS:
            with self.subTest(missing=missing):
                issues = self.check([(name, content) for name, content in ASSETS.items() if name != missing])
                self.assertTrue(any("缺少技能资源" in issue and missing in issue for issue in issues))

    def test_modified_asset_is_rejected(self) -> None:
        for changed in ASSETS:
            with self.subTest(changed=changed):
                issues = self.check([(name, content + b"changed" if name == changed else content)
                                     for name, content in ASSETS.items()])
                self.assertTrue(any("摘要不匹配" in issue and changed in issue for issue in issues))

    def test_extra_or_duplicate_asset_is_rejected(self) -> None:
        for extra, label in ((next(iter(ASSETS.items())), "重复技能资源"),
                             (("unexpected/SKILL.md", b"unexpected"), "来源不明")):
            with self.subTest(label=label):
                self.assertTrue(any(label in issue for issue in self.check([*ASSETS.items(), extra])))


if __name__ == "__main__":
    unittest.main()
