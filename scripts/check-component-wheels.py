"""检查组件 wheel 的发布身份，并可在独立环境运行已安装的命令。"""
from __future__ import annotations

import argparse
import configparser
import os
import subprocess
import tempfile
import venv
from email.parser import BytesParser
from pathlib import Path
from zipfile import ZipFile


def check(wheel: Path, install: bool) -> None:
    package, version, *_ = wheel.name.split("-")
    name = package.replace("_", "-")
    dist_info = f"{package}-{version}.dist-info"
    with ZipFile(wheel) as archive:
        metadata = BytesParser().parsebytes(archive.read(f"{dist_info}/METADATA"))
        if (metadata["Name"], metadata["Version"]) != (name, version):
            raise ValueError(f"wheel 元数据与文件名不一致：{wheel.name}")
        license_name = f"{dist_info}/licenses/LICENSE"
        repository_license = Path(__file__).resolve().parents[1] / "LICENSE"
        if (
            metadata["License-Expression"] != "MIT"
            or "LICENSE" not in metadata.get_all("License-File", [])
            or archive.namelist().count(license_name) != 1
            or archive.read(license_name) != repository_license.read_bytes()
        ):
            raise ValueError(f"{wheel.name} 缺少与根许可证逐字一致的项目 LICENSE")
        entry_points = configparser.ConfigParser()
        entry_points.read_string(archive.read(f"{dist_info}/entry_points.txt").decode("utf-8"))
        if name not in entry_points["console_scripts"]:
            raise ValueError(f"wheel 缺少命令入口：{name}")
    if install:
        with tempfile.TemporaryDirectory(prefix="coremind-component-") as temp:
            project = Path(temp)
            environment = project / ".venv"
            venv.EnvBuilder(with_pip=True).create(environment)
            scripts = environment / ("Scripts" if os.name == "nt" else "bin")
            python = scripts / ("python.exe" if os.name == "nt" else "python")
            cli = scripts / (f"{name}.exe" if os.name == "nt" else name)
            # 仅从指定 wheel 安装该组件；依赖使用公开索引或离线验收提供的本地 wheelhouse。
            env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
            subprocess.run(
                [str(python), "-m", "pip", "install", "--disable-pip-version-check",
                 "--index-url", "https://pypi.org/simple", str(wheel.resolve())],
                cwd=project, env=env, check=True,
            )
            subprocess.run([str(python), "-m", "pip", "check"], cwd=project, env=env, check=True)
            actual = subprocess.check_output(
                [str(cli), "--version"], cwd=project, env=env, encoding="utf-8",
            ).strip()
            if actual.split()[-1:] != [version]:
                raise ValueError(f"{name} --version 输出异常：{actual}")
    print(f"{wheel.name} {'独立安装和命令通过' if install else '元数据和命令入口通过'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheels", nargs="*", type=Path)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    for item in args.wheels:
        check(item, args.install)
