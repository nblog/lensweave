# 00 · 系统总览与架构决策

AI 短剧 / 漫剧生产平台。把已在 `test/` 里 PoC 验证过的"文本生成 → 文生图 / 图文生图 → 图文生视频"链路，工程化为一个有数据模型、有适配层、有前后端的可迭代系统。

本文是文档集的入口，先定调技术选型与四项关键架构决策（ADR），再分发到各专题文档。所有后续实现都以这里记录的决策为准；改动决策必须回到本文同步 ADR，而不是在下游代码里悄悄偏移。

---

## 1. 这个系统在做什么

一句话：**把"一段小说 / 剧情"逐级压缩成"可逐段渲染的视频"，并给创作者一个可视化的工坊去编排资产与镜头。**

整条生产链来自 [test/instructions/00_pipeline.md](../test/instructions/00_pipeline.md)，是一条刚性的线性管线，最小执行单元是 **segment（15s 量级的镜头碎片）**：

```
小说原文
  │  ① 01_小说解读
[StoryDigest] 故事摘要
  │  ② 02_剧集策划
[CharacterBible] 人物圣经 + [WorldBible] 世界圣经 + [EpisodeMap] 分集总表
  │
  ├─► ③ 04 角色/道具设计师 ─► [CharacterSheet]/[PropSheet] 视觉资产（文→图）
  ├─► ④ 05 场景设计师      ─► [SceneBoard]    视觉资产（文→图 / 图文→图）
  │
  ▼  ⑤ 03_单集剧本
[EpisodeScript] 单集文学剧本
  │  ⑥ 06_分集分镜
[StoryboardJSON] 结构化镜头语言（segments[]，每段 ≤15s）
  │  ⑦ 07_分镜设计师
[StoryboardSheet] 草稿分镜板（与 segment 1:1）
  │  ⑧ 08_视频生成执行
逐段 MP4（按转场语义剪辑拼接）
```

Segment 是未来逐段出片的最小结构单元：一集短剧最终会由多个 15s 量级的视频段组成。但当前阶段不要求 `Episode` 预设固定总时长，也不从总时长推导 segment 数量；06 分镜阶段接入后再负责把剧情切成多个可拍摄片段。

## 2. PoC 现状（工程化的起点）

`test/` 下已有四个可独立运行的 PEP 723 脚本，它们是适配层要抹平的原始素材：

| 能力 | 脚本 | SDK | 默认模型 | 网关 |
|---|---|---|---|---|
| 文本生成 | [test/textgen.py](../test/textgen.py) | AgentScope 2.x | `deepseek-v4-pro` | `api.routin.ai/v1` |
| 文生图 / 图文生图 | [test/imagegen2.py](../test/imagegen2.py) | agent-framework (OpenAI Responses + `image_generation` tool) | `gpt-5.4` | `api.routin.ai/v1` |
| 图文生视频 | [test/videogen.py](../test/videogen.py) | Volcengine Ark Runtime | `doubao-seedance-2-0-fast` | `api.routin.ai/api/v3` |
| 图文生视频（备） | [test/videogen-xai.py](../test/videogen-xai.py) | xai-sdk | — | `api.routin.ai/xai/v1` |

三个核心脚本指向同一个网关 `api.routin.ai` 却走了三套 SDK——这正是适配层存在的理由（见 [ADR-002](#adr-002-适配层抽象最小生成契约由渠道继承)）。三者已统一的约定：BOM 容忍的 UTF-8 读取、`--prompt-file` 长输入、异步任务提交 + 轮询、本地图片内联为 `data:` URI、参考图槽与首尾帧槽互斥。

> ⚠️ 安全项：PoC 脚本里 API key 是硬编码的（如 [test/imagegen2.py:45](../test/imagegen2.py#L45)）。工程版统一收敛到 `.env` + pydantic-settings，密钥不入库（`.gitignore` 覆盖 `.env`）。

## 3. 技术选型

| 层 | 选型 | 依据 |
|---|---|---|
| 后端语言 | Python ≥ 3.12 | 与 PoC 一致 |
| 包管理 | **uv** | 用户指定，`uv init` 起步 |
| 数据建模 | **pydantic v2** | 序列化 / 反序列化 + schema 即约束 |
| ORM | **SQLAlchemy 2.x** + SQLite | 用户指定，为日后迁移降成本；前期 SQLite 足够 |
| 迁移 | **Alembic** | SQLAlchemy 官方迁移工具 |
| CLI | **Typer** | 与 PoC 一致，便于 pytest 驱动 |
| HTTP 接口 | **FastAPI** | 给前端提供调用接口；与 pydantic 天然集成 |
| 配置 | **pydantic-settings** | `.env` → 类型化配置 |
| 测试 | **pytest** | 渐进式 `test/01-*` … `test/xx-*` |
| 前端语言 | TypeScript + React | 用户指定 |
| 前端脚手架 | **Vite** | React/TS 现代默认 |
| i18n | **react-i18next** | 中 / 英双语，首屏即生效 |
| 画布 | **React Flow (@xyflow/react)** | 自由编排 DAG（见 [ADR-001](#adr-001-前端画布采用自由编排-dag)） |
| 状态 | Zustand + TanStack Query | 画布本地态 + 服务端态分离 |

依据：选型遵循"优先成熟库、不重造轮子"，并尽量与 PoC 已验证的栈（Typer / pydantic / OpenAI-compat）保持连续。

## 4. 目录结构（目标形态）

```
ai-drama-flow/
├─ docs/                      # 本文档集
├─ backend/
│  ├─ pyproject.toml          # uv init 产出
│  ├─ src/ai_drama/
│  │  ├─ models/              # pydantic schema（StoryDigest / Bible / StoryboardJSON ...）
│  │  ├─ db/                  # SQLAlchemy ORM + Alembic
│  │  ├─ adapters/            # 文/图/视频生成基类 + routin 实现
│  │  ├─ pipeline/            # 01–08 各阶段编排（agent prompt 落地）
│  │  ├─ services/            # 业务逻辑（项目/资产/分集/任务）
│  │  ├─ api/                 # FastAPI 路由
│  │  ├─ cli/                 # Typer 命令
│  │  └─ config.py            # pydantic-settings
│  └─ tests/                  # pytest（含从 test/ 迁移的渐进式用例）
├─ frontend/
│  ├─ package.json            # npm init 产出
│  └─ src/
│     ├─ i18n/                # 中/英 locale
│     ├─ pages/               # 创建项目 / 分集 / 资产 / EP 工坊
│     ├─ canvas/              # React Flow 画布与节点
│     └─ api/                 # 后端接口客户端（OpenAPI 生成）
└─ test/                      # 原 PoC（保留，作为人类入口的渐进式参考）
```

## 5. 架构决策记录（ADR）

四项决策已与需求方确认，是本项目的地基。

### ADR-001 · 前端画布采用自由编排 DAG

**决策**：EP 工坊画布是一个通用有向图。节点类型涵盖 `剧集内容` / `人物资产` / `道具资产` / `场景资产` / `视频输出` 等；节点间用**有序连线**连接，连线顺序（1→2→3）即上下文传入顺序。

**背景**：需求方明确选择"自由编排 DAG"而非"按 segment 自动展开"或"EP 单节点"。图1工坊的形态、"多条线且线有顺序"的描述都指向通用图编辑器。

**权衡**：自由度最高，但带来约束成本——画布允许的拓扑必须收敛到 pipeline 能消费的形状。因此引入 **CanvasGraph schema**（见 [01 领域模型](01_domain_model.md)）作为护栏：节点类型、连线合法性、执行序由 schema 校验，避免"无穷多种正确路径"导致下游无法解析。前端负责"约束用户不越界"，正是需求方对前端的定位。

**影响**：领域模型需要一等公民 `CanvasGraph`（nodes + ordered edges），并定义"图 → pipeline 输入"的编译规则。

### ADR-002 · 适配层抽象最小生成契约，由渠道继承

**决策**：adapter 只定义**必要的"生成"方法与必要参数**（text / image / video 三个基类），具体厂商（首版 routin.ai 网关）继承实现。统一走 OpenAI-compat 网关优先。

**背景**：需求方选择"统一网关优先"。PoC 三脚本同指 `api.routin.ai` 但 SDK 各异，证明了"只实现必要生成 + 平台继承"的价值。

**权衡**：第一版只接 routin 一个渠道，维护成本最低；其他厂商留扩展位（继承基类即可接入），不预先抽象未验证的差异，避免"顺手通用化"。

**影响**：见 [02 适配层](02_adapter.md)。基类字段对齐 PoC 已验证的参数子集（如 image 的 size/quality、video 的 resolution/ratio/duration/参考图槽）。

### ADR-003 · 异步任务走轻量模型（无独立 broker）

**决策**：视频 / 图像生成是异步（提交 + 轮询）。后端用 **FastAPI BackgroundTasks + DB 持久化 job 状态 + 前端轮询 / SSE**，不引入 Redis / Celery / arq。

**背景**：需求方选择"轻量优先"。前期 SQLite 量级，独立 broker 是过度复杂。

**权衡**：单机、进程内任务，重启会丢失运行中的内存任务——但 job 状态持久化在 DB，可借 PoC 已有的 `videogen poll` 思路恢复轮询（任务在服务端继续跑）。日后规模上来再换 arq + Redis，job 表结构不变。

**影响**：见 [03 后端接口与任务](03_backend_api.md) 的 `GenerationJob` 表与状态机。

### ADR-004 · 第一个里程碑是骨架端到端

**决策**：MVP = 项目 / 分集 CRUD + 全局资产库 + 画布 + **VideoGen 节点「图文生视频」端到端跑通**；8 阶段 agent 先只接 1–2 个关键阶段（06 分镜 + 08 视频装配），其余留接口桩。

**背景**：需求方选择"骨架端到端优先"，先证明全链路打通，再补全 agent 阶段。

**影响**：见 [05 路线图](05_roadmap.md)。

### ADR-005 · 资产是全局库，项目按引用关联（可追源）

**决策**：视觉资产（人物 / 道具 / 场景）不再隶属于单个项目，而是一个**全局资产库**。项目通过多对多关联**引用**已存在的全局资产；同一资产可被多个项目共享。资产表保留可空的 `source_project_id`，记录它最初由哪个项目（的 02 Bible）生成，以便追源。

**背景**：需求方明确——资产应先于"创建项目"存在、可独立维护、可跨项目复用，而不是"创建项目后才能配置、且与项目绑死"。创建项目后用户看到的只有"分集"，资产在独立的全局库里管理。

**权衡**：相比"资产挂在项目下"（一对多），全局库需要一张关联表（`ProjectAsset`）和一个独立的资产管理入口，复杂度略增；但它换来真正的跨项目复用与"视觉身份的单一事实源"。pipeline 的 02→04/05 生成链路不破坏：02 的 CharacterBible 仍可驱动出图，产物**发布到全局库**并标注 `source_project_id`，而非写回某个项目私有的资产列表。

**影响**：见 [01 领域模型](01_domain_model.md) 的全局 `Asset` + `ProjectAsset` 关联表，以及 [04 前端](04_frontend.md) 的全局资产库页面与"创建项目后只见分集"的页面流。

### ADR-006 · 画布节点是通用计算图（数据节点 + 适配器节点）

**决策**：把 EP 工坊画布从"资产 / 内容 / 视频输出"的专用图，升级为**通用计算图**。节点是一个继承体系，基类 `Node` 只含 `name` 等公共字段，派生出两大类：

- **数据节点 `DataNode`**：承载一个值并通过输出端口对外提供 —— `TextNode`（文本）/ `ImageNode`（图像，可引用全局 `Asset` 或为上游产物）/ `VideoNode`（视频）。
- **适配器节点 `AdapterNode`**：表示一次"生成"操作，1:1 映射 [02 适配层](02_adapter.md) 的三个 adapter 基类 —— `TextGenNode`（文→文）/ `ImageGenNode`（文 + 多图(可选)→图）/ `VideoGenNode`（文 + 多图(可选)→视频）。适配器节点有类型化输入端口和一个输出端口，输出连向独立的数据节点，于是可串接成完整 pipeline（文本 → TextGen → 文本 → ImageGen → 图 → VideoGen → 视频）。

**背景**：需求方要求节点是可派生的 struct（基类含 `name`，派生出文本 / 图像 / 视频与各类适配器节点），且适配器以"文→文 / 文+多图→图 / 文+多图→视频"三种形态对应已验证的三个 PoC 适配器。这把整条 pipeline 都纳入画布，新增一种适配器只需新增一个 `AdapterNode` 子类。

**权衡**：相比专用图，节点种类更多、连线校验从 ad-hoc 规则升级为**端口类型兼容**校验（TextGen 入口只收 text，ImageGen/VideoGen 入口收 text + image*）。换来的是统一、可组合、可派生的模型——"生成资产图"也能在画布里完成，不必单开流程。人物 / 道具 / 场景不再是节点类型，语义由 `ImageNode` 引用的全局 `Asset.kind` 承载；参考图的 `@图1人物 @图3场景` 顺序约定降级为"适配器节点多图输入口的有序清单 + 各图引用的 `Asset.kind`"，与 [videogen.py](../test/videogen.py) 实际 API（参考图统一 `role=reference_image`）一致。

**影响**：见 [01 领域模型](01_domain_model.md) §2.3 的节点继承体系与端口类型校验，以及 [04 前端](04_frontend.md) §3 的 6 种通用节点与连线护栏。

### ADR-007 · 模型参数约束以 catalog YAML 为真源，运行时只消费 Pydantic 视图

**决策**：视频生成这类模型参数（如 `duration.min/max/default`、`resolution.options/default`）不在 service、adapter 或前端模块里重复硬编码。它们以 `backend/src/ai_drama/config/model_catalog/*.yaml` 为业务真源；运行时代码通过一个窄 Pydantic typed view 读取需要的字段，再把该 typed view 暴露给 compiler/API/frontend。

**背景**：`VideoGenNode` 的时长和分辨率既影响前端控件，也影响后端 `CanvasGraph → VideoGenRequest` 编译。如果每个模块各自保存 `15 / 4 / 15 / 720p / 480p...`，默认值与可选项会很快漂移。项目本身已经把 pydantic 作为"schema 即约束"的基础，因此 catalog 不能退化成到处传递的弱 `dict`。

**权衡**：只声明当前运行时消费的 YAML 子结构，而不是为整个 catalog 建一个庞大全量 schema。Pydantic model 使用 `extra="ignore"` 接纳未消费字段；这让 YAML 可以继续承载模型展示、provider、credential、prompt 等信息，同时保证业务代码读取到的是命名字段和校验后的默认/边界值。

**影响**：新增 typed catalog accessor（如 `get_seedance_video_settings()`）作为唯一入口。`VideoGenRequest` 保持 adapter 请求结构，不承载 Seedance 业务默认值；`canvas_compiler` 从 catalog typed view 填充默认值并做边界校验；前端通过后端 catalog endpoint 渲染 `VideoGenNode` 参数控件。

## 6. 文档导航

| 文档 | 内容 |
|---|---|
| [01 领域模型](01_domain_model.md) | pydantic schema + SQLAlchemy ORM；CanvasGraph；pipeline 数据契约落地 |
| [02 适配层](02_adapter.md) | text/image/video 生成基类 + routin 实现 |
| [03 后端接口与任务](03_backend_api.md) | FastAPI 路由 + Typer CLI + 轻量异步 job |
| [04 前端](04_frontend.md) | React/TS、i18n、自由编排画布、页面流 |
| [05 路线图](05_roadmap.md) | MVP 里程碑 + 渐进式 `test/01-*` 测试计划 |

## 7. 设计原则（贯穿全项目）

- **Schema 即约束**：每个阶段的输入输出都是结构化文档，不是自由散文。schema 把生成结果收敛到一条线（源自 pipeline 设计原则）。
- **角色一致性 ≥ 镜头炫技**：04/05 视觉资产是基线，下游禁止漂移。
- **小步可回放**：每个阶段产出都可独立 review，问题就近上游修复。
- **轻装主义**：用最小够用的抽象匹配当前证据，不为未验证的差异预造框架。
