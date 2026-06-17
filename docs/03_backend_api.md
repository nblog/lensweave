# 03 · 后端接口与异步任务

后端 core 对外有两个入口：**Typer CLI**（便于 pytest 驱动与本地单步验证）与 **FastAPI HTTP 接口**（给前端调用）。两者都是薄壳——真正的业务逻辑在 service 层，CLI 与 API 只负责参数解析、调用 service、格式化输出。这样同一份业务逻辑既能被命令行验证，又能被前端消费，不重复实现。

异步生成（尤其视频）按 [ADR-003](00_overview.md#adr-003-异步任务走轻量模型无独立-broker) 走**轻量模型**：FastAPI BackgroundTasks + DB 持久化 job 状态 + 前端轮询 / SSE，不引入 Redis / Celery / arq。

---

## 1. 分层

```
api/ (FastAPI 路由)  ─┐
cli/ (Typer 命令)    ─┴─► services/ (业务逻辑) ─► adapters/ + db/ + pipeline/
```

service 层函数是异步的、不依赖 FastAPI/Typer 的纯业务函数。CLI 用 `asyncio.run` 包一层（对齐 PoC 里 [textgen.py](../test/textgen.py) 的 `_run_generate` 模式），API 直接 `await`。

## 2. Typer CLI（`src/ai_drama/cli/`）

CLI 的价值是"人类与 pytest 的单步入口"——每个 pipeline 阶段、每个 adapter 都能独立跑、独立验。命令分组对齐领域：

```
ai-drama project create  --title "赘婿翻身"
ai-drama project list

ai-drama digest run       --project 1 --novel-file 剧情内容.md   # 01 小说解读
ai-drama plan run         --project 1                            # 02 剧集策划
ai-drama asset gen        --project 1 --kind character --name 林沅 # 04/05 资产出图
ai-drama script run       --project 1 --ep 1                      # 03 单集剧本
ai-drama storyboard run   --project 1 --ep 1                      # 06 分集分镜
ai-drama video submit     --segment 12                            # 08 提交视频任务
ai-drama job poll         --job <job_id>                          # 恢复轮询（对齐 videogen.py poll）
```

> 设计取向：CLI 命令与 pipeline 阶段一一对应，让"渐进式验证"成为可能——可以只跑 `storyboard run` 验证 06 的段数闭合，不必跑完整链路。这正是把 [test/](../test/) 里 PEP 723 脚本的"单脚本单能力"理念延续到工程版。

## 3. FastAPI 接口（`src/ai_drama/api/`）

REST 风格，资源对齐领域模型。所有请求/响应体复用 [01 领域模型](01_domain_model.md) 的 pydantic 模型——FastAPI 直接拿 pydantic 当 schema，自动产出 OpenAPI，前端据此生成类型化客户端。

### 3.1 项目与阶段产出

```
POST   /api/projects                      创建项目
GET    /api/projects                      列表
GET    /api/projects/{id}                 详情（含各阶段产出状态）
POST   /api/projects/{id}/digest          运行 01 小说解读（输入小说原文）
POST   /api/projects/{id}/plan            运行 02 剧集策划 → Bible + EpisodeMap
```

### 3.2 资产（全局库，ADR-005）

资产是全局的，不挂在项目路径下。项目通过关联端点引用全局资产。

```
GET    /api/assets                        全局资产列表（可按 ?kind= 过滤）
POST   /api/assets                        创建全局资产（spec，可带 source_project_id）
GET    /api/assets/{id}                    资产详情（含 image_path）
POST   /api/assets/{id}/generate          触发 04/05 出图 → 返回 job

GET    /api/projects/{id}/assets          某项目已引用的资产
POST   /api/projects/{id}/assets/{asset_id}    项目引用一个全局资产（建关联）
DELETE /api/projects/{id}/assets/{asset_id}    解除引用（不删全局资产）
```

> 资产的创建与生成在全局命名空间（`/api/assets`）；`/api/projects/{id}/assets` 仅管理项目↔资产的**引用关系**，对应 `ProjectAsset` 关联表。画布资产节点的 `ref_id` 指向全局 `Asset.id`。

### 3.3 分集与画布

```
GET    /api/projects/{id}/episodes        分集列表
POST   /api/projects/{id}/episodes        创建分集（自动/手动分集，见下）
POST   /api/episodes/{id}/script          运行 03 单集剧本
POST   /api/episodes/{id}/storyboard      运行 06 分集分镜 → segments[]
GET    /api/episodes/{id}/segments        segment 列表

GET    /api/episodes/{id}/canvas          读取 CanvasGraph
PUT    /api/episodes/{id}/canvas          保存 CanvasGraph（前端画布持久化）
POST   /api/episodes/{id}/canvas/compile  编译画布 → VideoGenRequest 预览（不提交）

GET    /api/model-catalog/seedance/video-settings
                                          读取 VideoGenNode 时长/分辨率控件配置
```

> **自动 / 手动分集**：`POST /episodes` 接受两种模式。`mode=auto` 时后端用 02 的 EpisodeMap 自动切分（一行一集）；`mode=manual` 时前端传入用户划定的集边界。两者最终都落成 `Episode` 行，差异只在"谁决定边界"。

> **模型参数配置**：`/model-catalog/.../video-settings` 不从 service 模块常量拼装，而是读取 [ADR-007](00_overview.md#adr-007-模型参数约束以-catalog-yaml-为真源运行时只消费-pydantic-视图) 的 typed catalog view；前端和 `CanvasGraph → VideoGenRequest` 编译器共享同一份默认值、范围和选项。

### 3.4 生成任务（异步核心）

```
POST   /api/segments/{id}/video           提交 08 视频生成 → 返回 job_id（立即返回，202）
GET    /api/jobs/{job_id}                 查询 job 状态（前端轮询）
GET    /api/jobs/{job_id}/events          SSE 流（可选，状态变更推送）
POST   /api/jobs/{job_id}/resume          恢复轮询（服务端任务仍在跑时）
```

## 4. 异步任务模型（ADR-003 落地）

### 4.1 状态机

`GenerationJob.status`（见 [01 §3](01_domain_model.md)）：

```
queued ──► running ──► succeeded
                  ├──► failed
                  └──► canceled
```

对齐 [videogen.py](../test/videogen.py) 的 `TERMINAL_STATUSES = {succeeded, failed, canceled}`。

### 4.2 提交—轮询流程

```
前端                     FastAPI                    BackgroundTask           routin VideoAdapter
 │  POST /segments/12/video  │                          │                          │
 ├──────────────────────────►│  建 GenerationJob(queued) │                          │
 │                           ├─ 入库, 起 BackgroundTask ─►│                          │
 │◄── 202 {job_id} ──────────┤                          │  adapter.submit(req) ────►│
 │                           │                          │◄── provider_task_id ─────┤
 │                           │                   存 provider_task_id, status=running │
 │  GET /jobs/{id} (轮询)     │                          │  循环 adapter.poll(...) ──►│
 ├──────────────────────────►│                          │◄── status/video_url ─────┤
 │◄── {status: running} ─────┤                   终态: 下载 MP4, 落 clip_path        │
 │  ...                       │                   status=succeeded, result 入库       │
 │  GET /jobs/{id}            │                          │                          │
 │◄── {status: succeeded,    │                          │                          │
 │      clip_path} ──────────┤                          │                          │
```

BackgroundTask 内部的轮询循环直接复用 [videogen.py](../test/videogen.py) `_poll_task` 的逻辑：固定间隔轮询、终态退出、超时保护。

### 4.3 重启恢复（轻量模型的代价对冲）

进程内 BackgroundTask 在服务重启时丢失，但任务在渠道侧继续跑。恢复机制：

1. 启动时扫描 DB 里 `status=running` 且有 `provider_task_id` 的 job。
2. 对每个重新起一个轮询 BackgroundTask（`POST /jobs/{id}/resume` 也可手动触发）。
3. 凭 `provider_task_id` 调 `adapter.poll` 继续——任务从未中断，只是本地轮询接回。

> 这把 [ADR-003](00_overview.md#adr-003-异步任务走轻量模型无独立-broker) 权衡里"重启会丢内存任务"的风险降到"丢的是轮询循环，不是任务本身"。job 表结构与 `provider_task_id` 字段是关键——日后换 arq + Redis 时，这套状态与恢复语义不变。

### 4.4 并发与限流

- 单进程内用 `asyncio.Semaphore` 限制同时在跑的生成任务数（防打爆渠道限流），默认值进 config。
- adapter 内部已有 SDK 级重试（对齐 PoC 的 `max_retries` + backoff），任务层不重复造重试框架——符合"轻装主义"。

## 5. 错误处理与可观测

- service 抛领域异常（如 `SegmentCollapseError` 来自段数校验），API 层统一映射为结构化错误响应（`{code, message, detail}`）。
- job 失败时 `error` 字段存渠道返回的 `code/message`（对齐 [videogen.py:190](../test/videogen.py#L190) 的错误提取），前端可展示。
- 日志：每个 job 的提交、状态变更、终态各记一条，带 `job_id` / `provider_task_id` 便于回溯。

## 6. 非目标

- 不做用户系统 / 鉴权（前期单机本地工具）。⚠️ 若日后把 FastAPI 暴露到网络，必须先补鉴权——无鉴权的网络服务是安全风险，届时单列。
- 不做 WebSocket 双向通道；状态推送用 SSE（单向，够用）。
- 不做分布式任务队列；规模触顶再迁 arq，job 表不变。
