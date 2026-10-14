from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("mcp_license_checker", ROOT / "scripts" / "check-python-wheel.py")
assert SPEC is not None and SPEC.loader is not None
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)
PREFIX = "coremind/_worker/vendor/mcp/"


class McpLicenseWheelTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="coremind-mcp-license-")
        self.addCleanup(temporary.cleanup)
        self.source = Path(temporary.name)
        lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))["packages"]
        self.manifest = {"schemaVersion": 1, "sources": {}, "artifacts": {}}
        self.assets: dict[str, bytes] = {}
        for name, filename, artifact in CHECKER.MCP_LICENSE_SOURCES:
            directory = self.source.joinpath(*name.split("/"))
            directory.mkdir(parents=True)
            locked = lock["node_modules/" + name]
            metadata = {"name": name, "version": locked["version"], "license": locked["license"]}
            (directory / "package.json").write_text(json.dumps(metadata), encoding="utf-8")
            content = b"shared fixture license\n" if name.startswith("@modelcontextprotocol/") else name.encode("utf-8") + b" fixture\n"
            files = {filename: (artifact, content)}
            if name == "eventsource":
                files["NOTICE"] = ("eventsource-NOTICE", b"fixture attribution\n")
            records = {}
            for source_name, (output, data) in files.items():
                (directory / source_name).write_bytes(data)
                self.assets[output] = data
                sha256 = hashlib.sha256(data).hexdigest()
                self.manifest["artifacts"][output] = sha256
                records[source_name] = {"artifact": output, "sha256": sha256}
            self.manifest["sources"][name] = {
                "version": metadata["version"], "license": metadata["license"],
                "integrity": locked["integrity"], "files": records,
            }
        self.assets["manifest.json"] = json.dumps(self.manifest).encode("utf-8")

    def check(self, files: dict[str, bytes], extra: tuple[str, bytes] | None = None) -> list[str]:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive, warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            for name, data in [*files.items(), *([extra] if extra else [])]:
                archive.writestr(PREFIX + name, data)
        with zipfile.ZipFile(buffer) as archive:
            return CHECKER.check_mcp_license_assets(archive, self.source)

    def test_shared_sdk_license_and_real_notice_mapping_pass(self) -> None:
        self.assertEqual(len(self.manifest["sources"]), 7)
        self.assertEqual(self.check(self.assets), [])

    def test_missing_manifest_license_or_notice_is_rejected(self) -> None:
        for missing in self.assets:
            with self.subTest(missing=missing):
                self.assertTrue(self.check({name: data for name, data in self.assets.items() if name != missing}))

    def test_modified_original_bytes_are_rejected(self) -> None:
        for changed in self.manifest["artifacts"]:
            with self.subTest(changed=changed):
                files = {**self.assets, changed: self.assets[changed] + b"changed"}
                self.assertTrue(any("来源摘要不匹配" in issue for issue in self.check(files)))

    def test_forged_license_and_matching_manifest_still_fail_source_hash(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        artifact = "modelcontextprotocol-LICENSE"
        truncated = b"Apache-only replacement"
        forged = hashlib.sha256(truncated).hexdigest()
        manifest["artifacts"][artifact] = forged
        for name in ("@modelcontextprotocol/client", "@modelcontextprotocol/core"):
            manifest["sources"][name]["files"]["LICENSE"]["sha256"] = forged
        files = {**self.assets, artifact: truncated, "manifest.json": json.dumps(manifest).encode("utf-8")}
        self.assertTrue(any("本地锁定来源" in issue for issue in self.check(files)))

    def test_invalid_manifest_and_forged_package_identity_are_rejected(self) -> None:
        for raw in (b"null", b"[]", b"{}", b"{", b"\xff"):
            with self.subTest(raw=raw):
                self.assertTrue(self.check({**self.assets, "manifest.json": raw}))
        for field, replacement in (("version", "0.0.0"), ("license", "MIT"), ("integrity", "sha512-forged")):
            with self.subTest(field=field):
                manifest = copy.deepcopy(self.manifest)
                manifest["sources"]["@modelcontextprotocol/client"][field] = replacement
                self.assertTrue(self.check({**self.assets, "manifest.json": json.dumps(manifest).encode("utf-8")}))
        manifest = copy.deepcopy(self.manifest)
        manifest["schemaVersion"] = True
        self.assertTrue(self.check({**self.assets, "manifest.json": json.dumps(manifest).encode("utf-8")}))

    def test_missing_or_changed_local_source_is_rejected(self) -> None:
        directory = self.source / "@modelcontextprotocol" / "client"
        (directory / "LICENSE").unlink()
        self.assertTrue(any("本地锁定来源" in issue for issue in self.check(self.assets)))
        (directory / "LICENSE").write_bytes(b"shared fixture license\n")
        package = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        package["version"] = "0.0.0"
        (directory / "package.json").write_text(json.dumps(package), encoding="utf-8")
        self.assertTrue(any("来源身份" in issue for issue in self.check(self.assets)))

    def test_unknown_or_duplicate_asset_is_rejected(self) -> None:
        for extra in (("unexpected", b"unexpected"), ("modelcontextprotocol-LICENSE", self.assets["modelcontextprotocol-LICENSE"])):
            with self.subTest(name=extra[0]):
                self.assertTrue(self.check(self.assets, extra))


if __name__ == "__main__":
    unittest.main()
