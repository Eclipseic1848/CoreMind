from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("wheel_checker", ROOT / "scripts" / "check-python-wheel.py")
assert SPEC is not None and SPEC.loader is not None
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)
PREFIX = "coremind/_worker/vendor/linux-sandbox/"


def assets() -> dict[str, bytes]:
    files = {"backend.mjs": b"export {};\n", "backend.d.mts": b"export {};\n",
             "LICENSE": b"Apache-2.0\n", "metafile.json": b"{}\n"}
    for arch, machine in (("x64", 62), ("arm64", 183)):
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        header[18:20] = machine.to_bytes(2, "little")
        files[f"bin/{arch}/apply-seccomp"] = bytes(header)
    manifest = {
        "schemaVersion": 1,
        "source": {"package": "sandbox-backend", "version": "1.0.0", "license": "Apache-2.0",
                   "files": {"backend.js": hashlib.sha256(b"source").hexdigest()}},
        "build": {"esbuild": "1.0.0", "entry": "export {};", "network": "denied", "proxies": False},
        "artifacts": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()
                      if name != "backend.d.mts"},
    }
    files["manifest.json"] = json.dumps(manifest).encode("utf-8")
    return files


def check(files: dict[str, bytes]) -> list[str]:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in files.items():
            archive.writestr(PREFIX + name, content)
    with zipfile.ZipFile(buffer) as archive:
        return CHECKER.check_linux_sandbox_assets(archive)


class LinuxSandboxWheelTest(unittest.TestCase):
    def test_complete_assets_pass(self) -> None:
        self.assertEqual(check(assets()), [])

    def test_missing_assets_are_rejected(self) -> None:
        for name in assets():
            with self.subTest(name=name):
                files = assets()
                del files[name]
                self.assertTrue(check(files))

    def test_modified_assets_are_rejected(self) -> None:
        for name in ("backend.mjs", "LICENSE", "metafile.json", "bin/x64/apply-seccomp", "bin/arm64/apply-seccomp"):
            with self.subTest(name=name):
                files = assets()
                files[name] += b"changed"
                self.assertTrue(any("摘要不匹配" in issue for issue in check(files)))

    def test_invalid_manifest_is_rejected(self) -> None:
        for content in (b"null", b"[]", b"{", b"\xff"):
            with self.subTest(content=content):
                files = assets()
                files["manifest.json"] = content
                self.assertTrue(check(files))

    def test_boolean_schema_version_is_rejected(self) -> None:
        files = assets()
        manifest = json.loads(files["manifest.json"])
        manifest["schemaVersion"] = True
        files["manifest.json"] = json.dumps(manifest).encode("utf-8")
        self.assertTrue(check(files))

    def test_invalid_boundary_or_digest_is_rejected(self) -> None:
        for section, key, value in (("build", "network", "allow"), ("build", "proxies", True),
                                    ("artifacts", "bin/x64/apply-seccomp", "invalid")):
            with self.subTest(section=section, key=key):
                files = assets()
                manifest = json.loads(files["manifest.json"])
                manifest[section][key] = value
                files["manifest.json"] = json.dumps(manifest).encode("utf-8")
                self.assertTrue(check(files))

    def test_wrong_helper_architecture_is_rejected_even_with_matching_hash(self) -> None:
        files = assets()
        name = "bin/arm64/apply-seccomp"
        files[name] = files["bin/x64/apply-seccomp"]
        manifest = json.loads(files["manifest.json"])
        manifest["artifacts"][name] = hashlib.sha256(files[name]).hexdigest()
        files["manifest.json"] = json.dumps(manifest).encode("utf-8")
        self.assertTrue(any("架构无效" in issue for issue in check(files)))


class WorkerBundleTest(unittest.TestCase):
    def test_workstation_paths_do_not_match_api_routes(self) -> None:
        # 在运行时构造完整反例，避免源码自身触发本机路径检查。
        for value in ("\\".join(("C:", "Users", "runner", "bundle.mjs")),
                      "/".join(("c:", "users", "runner", "bundle.mjs")),
                      "/".join(("F:", "new branch", "example", "bundle.mjs")),
                      "/".join(("", "home", "runner", "bundle.mjs")),
                      "file://" + "/".join(("", "Users", "runner", "bundle.mjs"))):
            with self.subTest(value=value):
                self.assertIsNotNone(CHECKER.WORKSTATION_PATH.search(value))
        for value in ("/projects/${project_id}/users/${userID}/roles",
                      "/organization/users/${userID}/roles", "/api/Users/account/roles"):
            with self.subTest(value=value):
                self.assertIsNone(CHECKER.WORKSTATION_PATH.search(value))

    def test_complete_license_and_regular_network_client_pass(self) -> None:
        bundle = CHECKER.MIT_LICENSE_NOTICE + "\n// node_modules/provider-client/node-http-proxy.js"
        self.assertEqual(CHECKER.check_worker_bundle(bundle), [])

    def test_incomplete_license_is_rejected(self) -> None:
        for notice in ("", CHECKER.MIT_LICENSE_NOTICE.replace("Copyright (c) 2025 Mario Zechner", ""),
                       CHECKER.MIT_LICENSE_NOTICE.replace("SOFTWARE.", "")):
            with self.subTest(notice=notice):
                self.assertTrue(any("版权许可" in issue for issue in CHECKER.check_worker_bundle(notice)))

    def test_removed_backend_modules_are_rejected(self) -> None:
        for module in ("node_modules/node-forge/lib/index.js",
                       "node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js",
                       "node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js",
                       "node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/tls-terminate-proxy.js"):
            with self.subTest(module=module):
                bundle = CHECKER.MIT_LICENSE_NOTICE + "\n// " + module
                self.assertTrue(any("已移除" in issue for issue in CHECKER.check_worker_bundle(bundle)))


if __name__ == "__main__":
    unittest.main()
