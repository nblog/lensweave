# 05 · 路线图与测试计划

按 [ADR-004](00_overview.md#adr-004-第一个里程碑是骨架端到端)：第一个里程碑是**骨架端到端**——项目/资产/分集 CRUD + 画布 + VideoGen 节点「图文生视频」跑通；8 阶段 agent 先只接 06（分镜）与 08（视频装配），其余留接口桩。先证明全链路打通，再回填 agent 阶段。

测试遵循需求方偏好的**渐进式分级**：`test/01-*` → `test/02-*` → … 从核心价值冒烟，到构建特性验证，再到端到端探索。ordered 测试同时是"人类读懂这套 AI 生成项目的入口"，降低 review 时的信息不对称。

---

## 1. 里程碑

### M0 · 脚手架（uv init / npm init）
- 后端 `uv init`，落 `pyproject.toml`、`src/ai_drama/` 骨架、`config.py`（pydantic-settings 收敛密钥到 `.env`，`.gitignore` 覆盖 `.env`）。
- 前端 `npm create vite`，落 React/TS + react-i18next 中英双语 + 顶栏语言切换。
- 验收：`ai-drama --help` 出命令树；前端首屏显示可切换语言的"创建项目"。

### M1 · 领域模型 + 持久化
- 落 [01](01_domain_model.md) 的 pydantic 模型与 SQLAlchemy ORM + Alembic 初始迁移。
- 重点先行：`StoryboardJSON._check_invariants`（segment_id 去重）、`CanvasGraph._validate_topology`（DAG + 连线合法性）。
- 验收：pydantic 校验拦住重复 segment_id 与非法画布拓扑；DB 建表成功。

### M2 · 适配层（routin 单渠道）
- 落 [02](02_adapter.md) 三基类 + routin 三实现，复用 PoC 纯函数。
- 验收：CLI 能用 routin adapter 各自产一段文本、一张图、一段视频（小样）。

### M3 · 骨架端到端（MVP 核心）
- 项目/资产/分集 CRUD（CLI + API）。
- 画布读写 + 编译（`CanvasGraph` → `VideoGenRequest`）。
- VideoGen 节点试渲：画布拼"人物+场景+剧集内容→视频输出" → 提交 job → 轮询 → job result 落 `clip_path` → 前端播放。
- 06 分镜 + 08 装配两个 agent 阶段接通；01/02/03/04/05/07 留桩（可手填或返回 mock）。
- 验收：从前端画布点击出片，端到端拿到一段 MP4。

### M4 · 回填 agent 阶段
- 按 pipeline 正向流程逐个接：01 解读 → 02 策划 → 04/05 资产出图 → 03 剧本 → 07 分镜板。
- 每接一个阶段，补一组对应的 ordered 测试。

## 2. 渐进式测试计划（`backend/tests/`）

| 阶段 | 关注 | 内容 |
|---|---|---|
| `test/01_smoke_*` | 核心价值冒烟 | 三个 adapter 各跑一次最小真实调用（标 `@pytest.mark.live`，默认 skip，需 `.env`）；离线则跑 mock adapter |
| `test/02_models_*` | schema 约束 | Segment 默认 15s / 单段上限、StoryboardJSON segment_id 去重；CanvasGraph DAG/连线合法性；枚举受控词表 |
| `test/03_adapter_*` | 适配层契约 | 请求 schema 互斥规则（视频首尾帧 vs 参考图槽）；PoC 纯函数迁移后的等价性（data URI 编码、role 注入） |
| `test/04_canvas_*` | 画布编译 | DAG → VideoGenRequest 的有序性（连线 order → 参考图固定顺序 @图1..@图4） |
| `test/05_job_*` | 异步任务 | job 状态机；提交→轮询→终态；重启恢复（扫 running + provider_task_id 接回轮询） |
| `test/06_e2e_*` | 端到端探索 | 建项目→建资产→分集→画布→出片全链路（live，手动触发） |

约定（对齐需求方偏好）：
- 真实 API 调用统一标 `@pytest.mark.live`，CI 默认跳过，避免每次跑测都打渠道、烧 token。
- 离线用 mock adapter（继承基类、返回固定产物）跑逻辑层，保证 02–05 阶段纯逻辑可在无网络下验证。
- ordered 命名让 reviewer 能从 01 顺着读懂系统：先看冒烟知道"能跑"，再看 models 知道"约束在哪"，逐级深入。

## 3. PoC → 工程版的迁移对照

| PoC 资产 | 去向 |
|---|---|
| [textgen.py](../test/textgen.py) `_run_generate` | `adapters/routin/text.py` |
| [imagegen2.py](../test/imagegen2.py) `_image_ref_to_content` / `_save_data_uri` | `adapters/routin/image.py` 私有方法 |
| [videogen.py](../test/videogen.py) `_build_content` / `_poll_task` / `poll` 命令 | `adapters/routin/video.py` + 任务层轮询/恢复 |
| 硬编码 api_key / base_url / model | `config.py` pydantic-settings ← `.env` |
| `test/instructions/*.md` | pipeline 阶段的 agent prompt 源（`pipeline/` 加载） |
| [test/instructions/06_分集分镜.md](../test/instructions/06_分集分镜.md) §2 schema | `models/storyboard.py` 的单一事实源 |
| `test/剧情内容.md` | e2e 测试的样例输入 |

> `test/` 原 PoC 脚本保留不动——它们是"人类入口"的渐进式参考，也是迁移正确性的对照基准。工程版 adapter 的产物应与对应 PoC 脚本一致。

## 4. 风险与待确认

- **段数 × 成本**：未来 06 分镜接入后，一个 3min EP 可能展开为十几段视频，全量出片的 API 成本与耗时较高。建议支持"节点试渲"与"整集批量"两档，批量默认走 `service_tier=flex`（[videogen.py](../test/videogen.py) 已有该参数，排队更便宜）。
- **agent 输出稳定性**：06 分镜即使有 schema 校验，LLM 仍可能产出重复 segment_id 或不可拍摄的分段。靠 `_check_invariants` 失败 + 就近重跑（pipeline"小步可回放"原则）兜底，必要时在 prompt 里回灌校验错误重试。
- **首版渠道单一**：routin 网关若不稳定，video 能力可快速接 [videogen-xai.py](../test/videogen-xai.py) 对应的 xAI 实现（基类已留扩展位）。

## 5. 下一步

文档确认后，按 M0 起步：先 `uv init` + `npm init` 落两个脚手架，再进 M1 领域模型。每个里程碑结束对照本文验收项与对应 ordered 测试。
