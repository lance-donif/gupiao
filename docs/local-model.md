# 本机模型

在项目根目录运行以下命令。需要 Python 3.12 或更高版本。默认使用标准档 Qwen3.5-2B（`--profile standard`），首次运行从公开发行页下载约 1.28 GB 的量化权重和 23 MB 的 Ubuntu x86-64 CPU 运行时，再校验两个文件的 SHA-256。模型保存在用户目录的 `~/.cache/echo-assistant/`，后续可离线启动。按 Ctrl+C 停止。

```sh
python scripts/local_model.py
```

在另一个终端验证服务已就绪。

```sh
curl -fsS http://127.0.0.1:18081/health
curl -fsS http://127.0.0.1:18081/v1/models
```

为工作台设置模型连接参数，再按根目录 README 启动工作台。这里的 `qwen-local` 是脚本设置的模型别名。`llama-server` 仅监听本机，应用进程需能访问同一个回环地址。

```dotenv
MODEL_BASE_URL=http://127.0.0.1:18081/v1
MODEL_NAME=qwen-local
MODEL_MAX_TOKENS_FIELD=max_tokens
MODEL_MAX_OUTPUT_TOKENS=768
MODEL_INPUT_USD_PER_MILLION=0
MODEL_OUTPUT_USD_PER_MILLION=0
```

## 标准档与轻量档

`standard` 档使用 Qwen3.5-2B 文本模型的 Q4_K_M 量化权重，适合在有更多内存的设备上运行中文对话和结构化工具调用。GGUF 文件大小为 1,280,835,840 字节，需要额外内存用于上下文和推理缓冲区。本次 Linux 双 CPU 线程、8192 token 上下文验证中，模型进程的常驻内存约为 2.0 GiB。脚本固定下载 Unsloth 仓库的修订 `f6d5376be1edb4d416d56da11e5397a961aca8ae`，发布的 SHA-256 为 `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223`。模型使用 Apache 2.0 许可证。[原始模型与许可证](https://huggingface.co/Qwen/Qwen3.5-2B) · [固定版本的量化权重](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/tree/f6d5376be1edb4d416d56da11e5397a961aca8ae)

```sh
python scripts/local_model.py --profile lite
```

该轻量档首次下载约 491 MB 的 Qwen2.5-0.5B-Instruct Q4_K_M 权重，适合验证聊天消息经过本机推理后的返回。两个档位均使用 8192 token 上下文和 `qwen-local` 别名，标准档关闭思考模式。不同模型在事实准确性和多步骤执行上表现可能不同。[轻量档权重](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/9217f5db79a29953eb74d5343926648285ec7e67) · [llama.cpp 发行版本](https://github.com/ggml-org/llama.cpp/releases/tag/b12560)

用以下请求检查返回的 `choices[0].message.content`。

```sh
curl --fail --silent http://127.0.0.1:18081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen-local","messages":[{"role":"user","content":"请用一句话介绍月球。"}],"max_tokens":80,"temperature":0}'
```

## 自备运行时和权重

在 macOS、Windows、ARM 或不兼容 Ubuntu 预编译包的 Linux 上，先安装适合本机的 llama.cpp，确保能运行 `llama-server`。脚本可接受该程序的路径与另一个 GGUF，仍使用 `qwen-local` 作为接口别名。自备权重可以加 `--model-sha256` 并填写发行方的摘要。

```sh
python scripts/local_model.py --server /path/to/llama-server --model /path/to/model.gguf
```

`--port` 更改端口，`--cache-dir` 更改下载缓存目录。脚本只在用户主动启动时下载。若提示缓存校验失败，删除提示中对应的缓存文件后重新运行。
