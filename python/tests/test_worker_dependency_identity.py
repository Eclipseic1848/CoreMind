from __future__ import annotations

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
SPEC = importlib.util.spec_from_file_location("worker_identity_checker", ROOT / "scripts" / "check-python-wheel.py")
assert SPEC is not None and SPEC.loader is not None
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)
PREFIX = "coremind/_worker/"


class WorkerDependencyIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="coremind-worker-identity-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        source = self.root / "python" / "src" / "coremind" / "_worker"
        source.mkdir(parents=True)
        worker = b"export {};\n"
        integrity = "sha512-" + "A" * 86 + "=="
        dependencies = {}
        packages = {}
        for index, name in enumerate(CHECKER.RUNTIME_DEPENDENCY_NAMES):
            relative = "node_modules/" + name
            directory = self.root / relative
            directory.mkdir(parents=True)
            (directory / "package.json").write_text(json.dumps({"name": name, "version": "1.2.0"}), encoding="utf-8")
            packages[relative] = {"version": "1.2.0", "integrity": integrity}
            dependencies[name] = {"version": "1.2.0", "integrity": integrity, "bundled": index == 0}
        self.manifest = {"schemaVersion": 1, "bundleSha256": hashlib.sha256(worker).hexdigest(),
                         "runtimeDependencies": dependencies}
        self.files = {"coremind-worker.mjs": worker, "manifest.json": json.dumps(self.manifest).encode("utf-8")}
        for name, content in self.files.items():
            (source / name).write_bytes(content)
        (self.root / "package-lock.json").write_text(json.dumps({"packages": packages}), encoding="utf-8")

    def check(self, files: dict[str, bytes], duplicate: str | None = None) -> list[str]:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive, warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            for name, content in files.items():
                archive.writestr(PREFIX + name, content)
            if duplicate is not None:
                archive.writestr(PREFIX + duplicate, files[duplicate])
        with zipfile.ZipFile(buffer) as archive:
            return CHECKER.check_bundled_worker_identity(archive, self.root)

    def test_frozen_worker_and_seven_actual_package_identities_pass(self) -> None:
        self.assertEqual(self.check(self.files), [])

    def test_missing_or_duplicate_worker_identity_files_fail(self) -> None:
        for name in self.files:
            with self.subTest(name=name):
                self.assertTrue(self.check({key: value for key, value in self.files.items() if key != name}))
                self.assertTrue(self.check(self.files, name))

    def test_self_consistent_forged_bundle_or_bundled_claim_cannot_replace_frozen_source(self) -> None:
        worker = b"export const replaced = true;\n"
        manifest = {**self.manifest, "bundleSha256": hashlib.sha256(worker).hexdigest()}
        self.assertTrue(self.check({"coremind-worker.mjs": worker, "manifest.json": json.dumps(manifest).encode("utf-8")}))
        manifest = json.loads(json.dumps(self.manifest))
        manifest["runtimeDependencies"][CHECKER.RUNTIME_DEPENDENCY_NAMES[-1]]["bundled"] = True
        self.assertTrue(self.check({**self.files, "manifest.json": json.dumps(manifest).encode("utf-8")}))

    def test_installed_metadata_or_lock_identity_drift_is_rejected(self) -> None:
        name = CHECKER.RUNTIME_DEPENDENCY_NAMES[0]
        metadata = self.root / "node_modules" / name / "package.json"
        metadata.write_text(json.dumps({"name": name, "version": "1.3.0"}), encoding="utf-8")
        self.assertTrue(any("实际 metadata/lock" in issue for issue in self.check(self.files)))
        metadata.write_text(json.dumps({"name": name, "version": "1.2.0"}), encoding="utf-8")
        filename = self.root / "package-lock.json"
        lock = json.loads(filename.read_text(encoding="utf-8"))
        lock["packages"]["node_modules/" + name]["integrity"] = "sha512-forged"
        filename.write_text(json.dumps(lock), encoding="utf-8")
        self.assertTrue(any("实际 metadata/lock" in issue for issue in self.check(self.files)))


if __name__ == "__main__":
    unittest.main()
