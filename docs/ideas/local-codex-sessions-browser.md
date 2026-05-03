# Local Codex Sessions Browser

## Problem Statement

如何让本地自用的 Euphony 自动读取 Codex CLI sessions，并按“项目 -> session 标题 -> session 内容”浏览，而不再需要手动上传 JSONL 文件？

## Recommended Direction

在现有 backend-assisted 模式中增加只读 Codex session API。后端扫描 `CODEX_HOME` 下的 rollout JSONL 和归档目录，抽取 session 元数据并组织成 `Git root -> session -> rollout items` 的派生视图。前端默认进入本地 Codex browser，点击 session 后复用现有 Codex renderer 渲染完整内容。

这个方向不改变 Codex CLI 的真实落盘结构。Codex sessions 的真实来源仍然是 append-only JSONL rollout 文件；Euphony 只负责构建更适合浏览的本地索引视图。

## Key Assumptions to Validate

- [ ] 大量 rollout 文件扫描在本机足够快；先实现全量扫描，再根据实测决定是否加缓存。
- [ ] `session_meta.cwd` 在历史 sessions 中覆盖率足够高；缺失时归到 `Unknown project`。
- [ ] 现有 `parseCodexSession` 能渲染真实 Codex sessions 的主要事件；不支持的事件先以 JSON/code block fallback。
- [ ] 使用者接受启动本地 FastAPI 后端作为读取 `~/.codex` 的前提。
- [ ] `CODEX_HOME` 未设置时使用用户目录下的 `.codex`；设置时尊重 `CODEX_HOME`。

## MVP Scope

- 后端扫描 active 和 archived rollout JSONL。
- 后端解析 session id、cwd、Git root、title、preview、createdAt、updatedAt、archived、rolloutPath。
- 前端默认展示项目列表和 sessions 列表。
- 点击 session 按需读取完整 JSONL，并用现有 Codex 渲染链路展示。
- 提供手动 Refresh。
- 保留现有 URL、剪贴板、本地文件加载入口。

## Data Model

项目层级由 session `cwd` 推导：

- 优先向上查找 `.git`，找到后用 Git 根目录作为 project id。
- 找不到 Git 根目录时回退到原始 `cwd`。
- 项目显示名使用目录名，同时保留完整路径用于消歧。

Session 标题按以下优先级推导：

- SQLite `threads.title` 或 `session_index.jsonl` 最新 `thread_name`。
- 首条用户消息生成的 preview。
- rollout 文件名中的时间和 thread id。

Session 内容来自 rollout JSONL 的完整 `RolloutItem` 序列，不从标题或项目目录反推。

## Proposed API

```text
GET /codex-sessions/projects/
GET /codex-sessions/sessions/?projectId=<project-id>
GET /codex-sessions/sessions/{session-id}/
```

`GET /codex-sessions/projects/` 返回项目列表和每个项目的 session 数量。

`GET /codex-sessions/sessions/?projectId=...` 返回该项目下的 session 摘要：`id`、`title`、`preview`、`cwd`、`rolloutPath`、`createdAt`、`updatedAt`、`archived`。

`GET /codex-sessions/sessions/{session-id}/` 读取完整 rollout JSONL，返回现有 Codex renderer 能消费的事件数组。

## Not Doing

- 不写入或修改 Codex session 状态。
- 不做重命名、归档、取消归档、删除 sessions。
- 不做文件监听实时更新。
- 不引入 Electron/Tauri 桌面封装。
- 不重排 Codex 原始落盘目录。
- 不允许前端传任意本地文件路径让后端读取。

## Open Questions

- 是否需要在后端读取 SQLite `state_5.sqlite` 作为优先索引，还是第一版只从 rollout 和 `session_index.jsonl` 抽取元数据？
- 项目和 session 列表是否需要全文搜索，还是先用浏览和浏览器页面内搜索解决？
- 默认排序是否统一使用 `updatedAt desc`？
