# Scripts

自动化文档生成、代码格式化、复杂度分析和其他实用脚本。

## 代码复杂度分析

### analyze_complexity.py - 复杂度分析工具

分析整个代码圈的圈复杂度（Cyclomatic Complexity）：

```bash
# 分析所有代码
python scripts/analyze_complexity.py

# 自定义复杂度阈值
python scripts/analyze_complexity.py --threshold 10
```

或使用 make:

```bash
make complexity           # 分析所有代码
make complexity-server    # 仅分析 Python
make complexity-web       # 仅分析 TS/React
```

**复杂度说明**:
- 圈复杂度衡量代码中的独立路径数量
- 推荐阈值：≤10（良好），≤15（可接受），>15（需要重构）
- 高复杂度函数应该拆分为更小的函数

**配置**:
- Python: 当前仅对仓库根目录与 `scripts/` 下的 Python 脚本做分析/格式化（不再以 `server/pyproject.toml` 作为现行配置）
- Web: `web/eslint.config.js` 与 `web/package.json` 中的 `lint:complexity` 脚本

---

## 代码格式化

### format_code.py - 统一格式化脚本

格式化整个项目的代码：

```bash
# 格式化所有代码
python scripts/format_code.py

# 仅检查格式（不修改）
python scripts/format_code.py --check
```

或使用 make:

```bash
make format           # 格式化所有代码
make format-check     # 检查代码格式
make format-server    # (legacy/retired) server/ 不再作为现行后端
make format-web       # 仅格式化 TS/React
make format-backend   # 仅修复 backend/ 的 eslint 可自动修复项
```

后端改动后先跑：`cd backend && bun run check:fix`。它会先自动修复，再跑 lint/typecheck/test；不能带 lint error 进入下一任务。

**格式化工具**:
- **Python**: Black (代码格式) + Ruff (linting & imports)
- **TypeScript/React**: Prettier

**配置**:
- Python: 仓库级脚本使用 Black/Ruff 默认行为（best-effort；未强绑定 server/ 配置）
- Web: `web/package.json` 中的 `format` / `format:check` 脚本

---

## 文档生成工具

### generate_docs.py - 主文档生成器

一次性生成所有项目文档：

```bash
# 生成所有文档
python scripts/generate_docs.py --all

# 仅生成 API 文档
python scripts/generate_docs.py --api

# 仅生成 Changelog
python scripts/generate_docs.py --changelog

# 仅生成架构图
python scripts/generate_docs.py --architecture
```

或使用 make:

```bash
make docs           # 生成所有文档
make docs-api       # 生成 API 文档
make docs-changelog # 生成 Changelog
make docs-architecture  # 生成架构图
```

### generate_api_docs.py - API 参考文档生成

从 TypeScript backend 的 HTTP shell 源码（`backend/src/http/index.ts`）扫描生成 API 端点文档。

**输出**: `docs/api-reference.md`

**前提条件**: 
- 当前 HTTP shell 不默认输出 OpenAPI；API docs 由源码扫描生成
- 如果本地缺少 `backend/src/http/index.ts`（例如只 checkout 了部分文件），脚本会写入 stub 文档但不会让整套 docs 生成失败

**用法**:
```bash
python scripts/generate_api_docs.py --output docs/api-reference.md
```

**功能**:
- 自动获取所有 API 端点
- 生成参数、请求体、响应文档
- 按标签分组展示
- 包含操作 ID 和摘要

### generate_changelog.py - 变更日志生成

从 git 提交历史自动生成 CHANGELOG.md。

**输出**: `CHANGELOG.md`

**用法**:
```bash
# 生成完整 changelog
python scripts/generate_changelog.py

# 仅生成特定日期之后的 changelog
python scripts/generate_changelog.py --since "2024-01-01"

# 指定输出文件
python scripts/generate_changelog.py --output docs/CHANGELOG.md
```

**功能**:
- 支持 conventional commits 格式识别
- 自动分类为 Features、Bug Fixes、Documentation 等
- 按月份分组
- 包含 commit hash 链接

**识别的提交类型**:
- `feat`: 新功能 ✨
- `fix`: Bug 修复 🐛
- `docs`: 文档更新 📚
- `refactor`: 代码重构 ♻️
- `perf`: 性能优化 ⚡
- `test`: 测试相关 ✅
- `build`: 构建系统 📦
- `ci`: CI/CD 👷
- `chore`: 日常维护 🔧

### generate_architecture_diagram.py - 架构图生成

从代码库结构自动生成系统架构文档。

**输出**: `docs/architecture/overview.md`

**用法**:
```bash
python scripts/generate_architecture_diagram.py
```

**功能**:
- 生成 Mermaid 格式架构图
- 包含系统架构总览
- Night/Morning 数据流图
- ML 分级系统流程图
- 技术栈说明
- 组件结构分析

## 其他实用脚本

历史上 `server/scripts/` 下有一些 Python 运维脚本，但 `server/` 现已进入退役阶段，不应再把它们当成现行后端入口。

## 自动化建议

建议将文档生成集成到 CI/CD 流程中：

```bash
# GitHub Actions 示例
- name: Generate Documentation
  run: |
    make docs
    git add docs/ CHANGELOG.md
    git commit -m "docs: auto-generate documentation" || true
```

或在每次发布前手动运行：

```bash
# 发布前生成最新文档
make docs
git add docs/ CHANGELOG.md
git commit -m "docs: update before release"
```
