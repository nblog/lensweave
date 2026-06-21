# 04 · 前端

前端的定位（来自需求方）：**控制用户的使用途径，约束其不越出 core 的边界，并提供数据展示与数据交互的 UX/UI。** 它不持有业务规则——规则在后端 schema 里；前端的任务是把这些规则翻译成"用户点不出错"的界面，并把 pipeline 的结构化产物可视化。

技术栈：TypeScript + React + Vite，路由用 React Router，i18n 用 react-i18next（中/英，首屏即生效），画布用 React Flow（`@xyflow/react`），服务端态用 TanStack Query、画布本地态用 Zustand。

---

## 1. i18n（第一优先级）

需求方要求"npm init 初始化后首先支持 i18n（英/中）"。

```
src/i18n/
├─ index.ts            # i18next 初始化，挂 LanguageDetector
├─ en/                 # 英文 locale（按页面/领域分文件）
└─ zh/                 # 中文 locale
```

约定：
- 所有 UI 文案走 `t('key')`，不硬编码字符串——这是"首先支持 i18n"的硬要求，从第一个组件就遵守，不留"以后再抽"的债。
- 语言切换在顶栏，选择持久化到 localStorage。
- 领域术语（segment / storyboard / 资产类型）中英对照集中在 `locale` 里维护，与后端枚举对齐，避免同一概念两套译名。

## 1.5 全局布局（宽屏自适应）

内容区采用**居中、约束最大宽度**的布局：主体占视口约 80%、两侧各留约 10% 留白，避免在宽屏（如 3357px）下内容被拉满或两侧留白过多。

- 实现：内容容器 `width: 80%`（或等价的 `margin-inline: auto` + `max-width`），上限设一个合理的最大宽度（如 1600px），小屏时回落到接近全宽。
- 例外：**EP 工坊画布**是高交互的工作区，可突破该约束、占用更宽空间（画布越大越好用），其外围控件见 [§3.5](#35-画布外围控件对齐需求方图2参考)。

> 需求方建议（供参考）：宽屏下 body 占整体 ~80%、两侧各留 ~10%。采纳为内容页默认布局；画布页因交互需要可放宽。

## 2. 页面流（对齐需求方描述的使用路径）

资产按**全局 / 项目固定 / 单集临时**三层披露（ADR-005）。顶层入口仍是项目；进入项目后，左侧承载本系列分集列表与阶段导航，右侧显示当前阶段页面内容。资产 stage 展示三层资产，临时资产以左侧当前选中的分集为边界。

页面流由 URL 路由承载，而不是用全局 nav/store 模拟页面状态：`/projects` 是项目列表，`/projects/:projectUid` 是项目工作台，`/projects/:projectUid/episodes/:episodeId/workshop` 是 EP 工坊。`projectUid` 来自后端 `Project.uid`，不使用数据库自增 `id`。项目工作台内部的剧本/资产 stage 是本页状态；涉及具体分集画布时再进入真实路由。

```
顶栏导航： [项目] [全局资产]  …………………………… [语言切换]
            │
            ▼
   ┌─────────────┐
   │ 项目列表     │
   │ [创建项目]   │
   └─────────────┘
            │
      打开某个项目
            ▼
   ┌──────────────────────────────────────────────┐
   │ 左侧：本系列分集 + stage 导航                 │
   │  ├─ 剧本                                      │
   │  ├─ 资产                                      │ ← 全局 / 项目固定 / 当前集临时资产
   │  └─ 工坊（进入某一集 EPXX）                   │
   │ 右侧：当前 stage 的页面内容                   │
   └──────────────────────────────────────────────┘
            │  进入某一集 EPXX
            ▼
   ┌──────────────────┐
   │   EP 工坊画布      │  ← 本系统的核心交互；引用当前 episode 可见资产
   └──────────────────┘
```

### 2.1 顶层导航（项目 / 全局资产）

顶栏提供"项目"、"全局资产"入口与语言切换。`/projects` 是项目列表；`/assets` 是全局资产库，只展示和上传 `scope=global` 的源资产。项目固定资产与单集临时资产仍进入项目工作台右侧管理。

### 2.2 创建项目（项目入口首屏）

"项目"入口显示项目列表与"创建项目"。创建完成后进入项目页。对应 `POST /api/projects`。

### 2.3 项目页：左侧导航 + 右侧页面

创建项目后，项目页采用白色工作台布局：左侧是一个容器，包含 `series-panel`（本系列分集列表与添加分集入口）和 `project-stage-panel`（剧本 / 资产 / 工坊阶段导航）；右侧 `project-page-panel` 显示当前 stage 的页面内容，不重复左侧分集列表。`series-panel` 里的分集是**当前分集选择器**，点击 EP01 / EP02 只更新项目工作台当前分集，不直接进入画布；下面的"工坊"入口才按当前选中分集进入 `/projects/:projectUid/episodes/:episodeId/workshop`。分集支持两种方式（对应 [03 §3.3](03_backend_api.md) 的 `mode`）：
- **自动分集**：调 01→02 产出 EpisodeMap，按"一句话主线"一行一集自动切。
- **手动分集**：用户自己划定集边界。

两者都落成 `Episode` 列表。手动添加分集的表单只要求填写 `标题`，不在创建 EP 时询问时长；具体生成视频片段的时长由 EP 工坊里的 `VideoGenNode` 参数控制。后端不维护 Episode 固定总时长字段，segment 的数量与切分由后续 06 分镜阶段决定。

### 2.4 项目资产页

项目页右侧的资产 stage 是**三层资产库**，展示并允许上传人物 / 道具 / 场景资产。顶部范围切换顺序是：全局资产 → 项目资产（固定资产）→ 临时资产（当前选中分集）。用户上传图片、选择资产范围、类型、名称和描述后，按范围分别提交 `POST /api/assets`、`POST /api/projects/{project_uid}/assets` 或 `POST /api/episodes/{episode_id}/assets`；图片预览框支持点击聚焦后直接粘贴剪贴板图片。内容区继续按资产类型分组展示卡片，桌面端采用受控五列网格，窄屏逐级降列，保证卡片大小稳定。卡片显示资产图、名称、类型、出场次数占位与描述；无图资产显示"暂无形象 / 待补图"占位。点击卡片打开资产编辑模态窗，可修改类型、名称、描述、替换 / 清空图片，并按资产层级调用对应的 `PATCH` 接口；删除资产必须二次确认，并按全局 / 项目固定 / 单集临时分别调用对应删除接口。资产是画布 `ImageNode` 的来源；EP 工坊从 `GET /api/episodes/{episode_id}/assets` 读取当前可见资产（全局 + 当前项目固定 + 当前单集临时）。

> 破坏性 / 难撤销操作统一走 `src/components/ConfirmDialog.tsx` 的 `useConfirm()`（返回 `Promise<boolean>`）：删除画布节点、覆盖已有上传图像等操作都 `await confirm(...)`，护栏一致且 DRY。

> 时间戳显示（创建于 / 上次保存 / 生成于）统一走 `src/utils/datetime.ts` 的 `formatTimestamp`（`YYYY-MM-DD HH:mm`），画布内的 `formatCanvasTimestamp` 是其薄封装，避免同一概念散落多套格式。

## 3. EP 工坊画布（核心交互，ADR-001）

进入某一集后是一块画布（即需求方图1的"工坊"形态），右侧是节点编辑面板。这是自由编排 DAG 的落地。

### 3.1 节点类型（通用计算图，ADR-006）

对齐 [01 §2.3](01_domain_model.md) 的 `NodeKind`。节点分两类：**数据节点**（承载值）与**适配器节点**（一次生成，1:1 对应三个 adapter）。人物/道具/场景不再是节点类型，由 `ImageNode` 引用的当前项目 `Asset.kind` 承载。

数据节点：

| 节点 | 输出类型 | 来源 / 内容 |
|---|---|---|
| 文本（TextNode） | text | 手填文本，或绑定 segment 的 `visual_prompt`（`ref_id`→Segment） |
| 图像（ImageNode） | image | 引用当前 episode 可见资产（`ref_id`→Asset，含人物/道具/场景语义），或上游生成产物 |
| 视频（VideoNode） | video | 上游 VideoGen 的产物 |

适配器节点（有类型化输入口 + 一个输出口）：

| 节点 | 输入 | 输出 | 对应适配器 |
|---|---|---|---|
| 文生文（TextGenNode） | text | text | TextAdapter |
| 图生成（ImageGenNode） | text + 多图(可选) | image | ImageAdapter |
| 视频生成（VideoGenNode） | text + 多图(可选) | video | VideoAdapter |

适配器节点的输出连向独立的数据节点，于是可串接成完整链路：文本 → TextGen → 文本 → ImageGen → 图 → VideoGen → 视频。

### 3.2 有序输入：顺序在适配器节点处体现

需求方明确：连线顺序不是"在连线上显示 1/2/3"，而是**在接收节点（适配器节点）处体现各输入的接入次序**——例如「图1、图2、图3、文字」依次连入 VideoGen 节点，该节点就知道"图1 第 1 个、图2 第 2 个、图3 第 3 个、文字 第 4 个"接入，便于生成时知道上下文传输顺序。

- 顺序的载体是 [01 §2.3](01_domain_model.md) 的 `CanvasEdge.order`（语义不变：连线顺序 = 上下文顺序）。
- **展示方式**：在适配器节点上（或其编辑面板里）列出一个**有序输入清单**，按接入次序编号显示每个上游节点（如 `1. 图·女主 / 2. 图·前院 / 3. 文本·镜头提示`），而不是给每条连线挂数字标签。
- 顺序默认按连入先后确定，用户可在清单上上移 / 下移调整，调整即更新 `order`。
- 这个有序清单直接编译成 08 的参考图固定顺序（`@图1人物 @图2分镜资产 @图3场景 @图4道具`）。

### 3.3 右侧节点编辑面板

选中节点 → 右侧编辑其参数：所有已支持的画布节点都可编辑通用节点标题；TextNode 额外编辑文本 / 绑定 segment；ImageNode 额外选择引用的当前 episode 可见资产、查看参考图；适配器节点额外查看 §3.2 的有序输入清单与生成参数覆盖，并以同一套运行状态显示 job 状态、错误与产物预览。`ImageNode` 和 `ImageGenNode` 共用图像预览框，图片均通过双击打开完整预览；`ImageNode` 保留右上上传控件但不显示左下收藏，`ImageGenNode` 的左下收藏按钮打开"保存为资产"模态窗。该模态窗默认保存到当前项目资产，用户可切换为全局资产，并在项目资产下选择固定 / 临时。模态窗必须显式取消 / 关闭 / 保存，点击遮罩不关闭，避免误丢填写内容。`VideoGenNode` 暴露 `视频时长（秒）` 与 `分辨率`；控件的默认值、范围和选项从后端 model catalog endpoint 读取，而该 endpoint 的真源是 [ADR-007](00_overview.md#adr-007-模型参数约束以-catalog-yaml-为真源运行时只消费-pydantic-视图) 的 typed YAML catalog view。编辑结果写入 `CanvasNode.data`，随画布持久化（`PUT /api/episodes/{id}/canvas`）。

### 3.4 前端即护栏：端口类型校验

前端在交互层就阻止用户连出 core 无法消费的图，把 [01 §2.4](01_domain_model.md) 的端口类型校验前移成交互约束：
- 连线时按**端口类型兼容**判断：source 的输出类型必须落在 target 适配器节点接受的输入类型集合内（TextGen 只收 text，ImageGen/VideoGen 收 text + image）。
- 数据节点不接受输入（无输入口）。
- 不允许成环（DAG）。
- 连线非法时即时反馈（连线变红 / 禁止落点），不等提交后端报错。
- 删除**节点**时弹确认，避免误删（React Flow 的 `onBeforeDelete` 返回 `Promise<boolean>` 拦截）；删除**连线**不弹确认——成本低且易恢复。

> 这正是需求方对前端的定位——"约束避免超出 core 边界"。后端 schema 是最终防线，前端护栏是第一道，两者用同一套端口类型规则，前端只是把它表达成交互。

### 3.5 画布外围控件（对齐需求方图2参考）

- **右下角全局预览**：用 React Flow 的 **MiniMap**（可拖拽的全局缩略图）放在右下角，便于在大画布里快速定位。
- **左上角状态浮层**：固定显示画布的 `节点数` 与 `上次保存时间`（不显示素材 / 资产列表）。节点数随编辑实时更新，保存时间在 `PUT /canvas` 成功后刷新。

### 3.6 触发生成与播放

适配器节点上有触发按钮 → 调对应生成端点（如 VideoGen 节点 → `POST /api/episodes/{id}/video`），拿 `job_id` 后用 TanStack Query 轮询 `GET /api/jobs/{job_id}`（或订阅 SSE），节点卡片上实时显示 `queued/running/succeeded` 状态、生成中 loading 覆盖层与已用时间，成功后产物回填到当前生成节点并可内嵌播放。图像生成产物可从节点卡片收藏为资产：默认提交 `POST /api/projects/{project_uid}/assets` 写入当前项目固定资产；选择临时资产时提交 `POST /api/episodes/{episode_id}/assets`；选择全局资产时提交 `POST /api/assets`。保存后刷新当前 episode 可见资产查询。任务结束后把最终耗时写入 `CanvasNode.data.generation_elapsed_ms`，刷新画布后仍能看到上次生成用时。未来逐段出片接入后，segment 定向视频任务仍可把 `clip_path` 写回对应 segment。

## 4. 状态管理

| 态 | 工具 | 范围 |
|---|---|---|
| 服务端态 | TanStack Query | 项目/资产/分集/job，带缓存与轮询 |
| 画布本地态 | Zustand | 画布**节点与连线**、节点位置、选中、未保存的编辑 |
| 语言偏好 | localStorage | i18n 选择 |
| 生成通道偏好 | localStorage | EP 工坊通道下拉（mock/routin） |

画布"保存"显式调 `PUT /canvas` 持久化；本地编辑先进 Zustand，避免每次拖拽都打后端。

画布的节点/连线状态持有在模块级 store（`src/stores/canvasStore.ts`），而非 `CanvasWorkshop` 组件内的 `useState`。原因有二：其一，这本就是上表"画布本地态用 Zustand"的落地；其二，[06 WebMCP 工具层](06_webmcp_tools.md) 的工具是构建期抽取的顶层导出函数，无法访问组件内 state，只能操作模块级 store。store 暴露画布业务动作（upsert/connect/setParams/delete/buildShotVideoGraph/persist/run*），UI 与 AI 工具共享同一份状态，故 AI 调用时画布实时更新。`CanvasNode.data` 的编辑结果随画布持久化（`PUT /api/episodes/{id}/canvas`）。

## 5. 接口客户端

从 FastAPI 的 OpenAPI（[03](03_backend_api.md) 自动产出）生成类型化 TS 客户端，前后端共享同一套 schema 形状。后端 pydantic 模型变更 → 重新生成客户端 → 编译期就能发现前端不匹配，落实"schema 即约束"贯穿前后端。

## 6. 非目标（前期）

- 不做拖拽时间线剪辑 / 成片合成界面——08 的逐段 MP4 拼接前期靠后期工具，前端只管单段出片与播放。
- 不做多人协作 / 实时同步。
- 不做主题定制；先一套清爽的工坊风格。
