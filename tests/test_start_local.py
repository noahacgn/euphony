from __future__ import annotations

import shutil
import socket
import subprocess
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
START_SCRIPT = PROJECT_ROOT / "scripts" / "start-local.ps1"


def test_start_local_defaults_to_backend_port_18020() -> None:
    script = START_SCRIPT.read_text(encoding="utf-8")

    # 默认端口是启动脚本的用户接口；锁定该值可防止前后端默认地址再次漂移。
    assert "[int]$BackendPort = 18020" in script


def test_start_local_rejects_occupied_backend_port_before_spawning_processes() -> None:
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if powershell is None:
        pytest.skip("本测试只验证 Windows PowerShell 本地启动脚本")

    # 由测试进程持续占用一个随机端口，稳定复现端口不可绑定场景，且不依赖本机固定端口状态。
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied_socket:
        occupied_socket.bind(("127.0.0.1", 0))
        occupied_socket.listen()
        occupied_port = occupied_socket.getsockname()[1]

        result = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(START_SCRIPT),
                "-SkipInstall",
                "-NoBrowser",
                "-BackendPort",
                str(occupied_port),
                "-FrontendPort",
                "3001",
            ],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            check=False,
        )

    output = f"{result.stdout}\n{result.stderr}"
    assert result.returncode != 0
    assert f"后端端口 127.0.0.1:{occupied_port} 不可用" in output
    assert "-BackendPort" in output
    assert "backend 已启动" not in output
