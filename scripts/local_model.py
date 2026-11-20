"""Download verified CPU inference assets and serve an OpenAI-compatible local model."""

import argparse
import hashlib
import os
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

BUILD = "b12560"
ARCHIVE = f"llama-{BUILD}-bin-ubuntu-x64.tar.gz"
SERVER_URL = f"https://github.com/ggml-org/llama.cpp/releases/download/{BUILD}/{ARCHIVE}"
SERVER_SHA = "a3f23ad06f5d94a653db3b265fa610afea749ee53f89f884e2fcbf05a7c2bd4e"
# Hugging Face LFS object digests are SHA-256 hashes of the GGUF contents.
PROFILES = {
    "lite": (
        "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        "9217f5db79a29953eb74d5343926648285ec7e67",
        "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    ),
    "standard": (
        "unsloth/Qwen3.5-2B-GGUF",
        "f6d5376be1edb4d416d56da11e5397a961aca8ae",
        "Qwen3.5-2B-Q4_K_M.gguf",
        "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    ),
}


def verify(path: Path, expected: str):
    with path.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected.lower():
        raise ValueError(f"{path.name} SHA-256 不匹配，期望 {expected}，实际 {actual}。")


def download(cache: Path, filename: str, url: str, expected: str) -> Path:
    target = cache / filename
    if target.exists():
        verify(target, expected)
        return target
    print(f"下载 {filename} …", flush=True)
    request = urllib.request.Request(url, headers={"User-Agent": "echo-assistant/0.1"})
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as tmp:
        partial = Path(tmp.name)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as dest:
            shutil.copyfileobj(response, dest, length=1024 * 1024)
        verify(partial, expected)
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=Path.home() / ".cache" / "echo-assistant")
    parser.add_argument("--profile", choices=PROFILES, default="standard", help="本机模型大小，默认 standard")
    parser.add_argument("--server", metavar="PATH", help="使用本机已安装的 llama-server 可执行文件")
    parser.add_argument("--model", type=Path, help="使用本机现有 GGUF 文件")
    parser.add_argument("--model-sha256", help="验证自备 GGUF 的 SHA-256")
    parser.add_argument("--port", type=int, default=18081)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port 应介于 1 到 65535")
    if args.model_sha256 and not args.model:
        parser.error("--model-sha256 需要搭配 --model")

    # Prefer the pinned release on supported machines. Other platforms may have
    # a native, hardware-accelerated llama-server installed by their operator.
    official_build = platform.system() == "Linux" and platform.machine() in {"x86_64", "amd64"}
    server = None
    if args.server or not official_build:
        server = shutil.which(args.server or "llama-server")
        if not server:
            parser.error("请先安装 llama.cpp，再用 --server 指定 llama-server 的位置。")
    cache = args.cache_dir.expanduser().resolve()
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.model:
        model = args.model.expanduser().resolve(strict=True)
        if args.model_sha256:
            verify(model, args.model_sha256)
    else:
        repo, revision, filename, digest = PROFILES[args.profile]
        url = f"https://huggingface.co/{repo}/resolve/{revision}/{filename}?download=true"
        model = download(cache, filename, url, digest)
    with model.open("rb") as f:
        if f.read(4) != b"GGUF":
            raise ValueError(f"{model.name} 缺少 GGUF 文件标识。")
    with tempfile.TemporaryDirectory(dir=cache) as runtime:
        if server is None:
            archive = download(cache, ARCHIVE, SERVER_URL, SERVER_SHA)
            with tarfile.open(archive, mode="r:gz") as bundle:
                bundle.extractall(runtime, filter="data")
            server = str(Path(runtime) / f"llama-{BUILD}" / "llama-server")
        print(f"模型 API 地址为 http://127.0.0.1:{args.port}/v1，模型名为 qwen-local。", flush=True)
        with subprocess.Popen(
            [
                server,
                "--model",
                str(model),
                "--alias",
                "qwen-local",
                "--host",
                "127.0.0.1",
                "--port",
                str(args.port),
                "--ctx-size",
                "8192",
                "--parallel",
                "1",
                *(["--reasoning", "off"] if args.profile == "standard" else []),
            ],
        ) as proc:
            previous = signal.signal(signal.SIGTERM, lambda _signum, _frame: proc.terminate())
            try:
                return proc.wait()
            except KeyboardInterrupt:
                proc.terminate()
                raise
            finally:
                signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, tarfile.TarError, urllib.error.URLError) as exc:
        sys.exit(str(exc))
    except KeyboardInterrupt:
        sys.exit(130)
