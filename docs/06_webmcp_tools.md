# 06 · WebMCP 工具层（AI 客户端操控工坊画布）

本文定义前端的 **WebMCP 工具层**：把 EP 工坊画布的业务动作暴露为一组稳定的浏览器内 MCP 工具，让本地 AI 客户端（Claude / Cursor / VS Code 等）通过工具调用，在用户**正打开的网页**上自然语言搭建画布。对应决策见 [ADR-008](00_overview.md#adr-008-前端以-webmcp-暴露画布业务命令层)。

> 一句话定位：**WebMCP 工具是"画布业务命令层"，不是 React 组件事件的外泄，也不是把每个节点实例动态工具化。** 它是一层薄桥，核心业务规则仍在后端 schema（[01](01_domain_model.md)）；工具层只把这些规则翻译成 AI"调不出错"的命令，与前端 UI 护栏（[04 §3.4](04_frontend.md)）同源。

---

## 1. 链路与技术选型

```
AI Client                      浏览器内
(Claude/Cursor/VS Code)
   │  stdio MCP
   ▼
@mcp-b/webmcp-local-relay  ──ws──►  隐藏 iframe 桥  ──►  navigator.modelContext
   (本地 relay)                      (embed.js 注入)         │
                                                            ▼
                                              webmcp-nexus-sdk 注册的工具函数
                                                            │ 复用
                                                            ▼
                                              canvasStore (zustand) ── flowToDto ──► api.saveCanvas
                                                            │
                                                            ▼
                                                  FastAPI 后端 (docs/03)
```

| 件 | 选型 | 作用 |
|---|---|---|
| SDK | `webmcp-nexus-sdk` | `registerGlobalTools` / `useWebMcpTools` 把 TS 函数注册到 `navigator.modelContext` |
| 构建插件 | 本地 `vite-webmcp-plugin.ts`（包装 `webmcp-nexus-core` 的 `transformCode`） | 构建期从 TS 类型 + JSDoc 抽取工具 schema，注入 `__webmcpSchema` |
| 本地桥 | `@mcp-b/webmcp-local-relay`（`embed.js`） | 注入隐藏 iframe，把 `navigator.modelContext` 桥到本地 WebSocket，给本地 MCP 客户端接入 |

**仅作开发/实验期的可视化操控层**：WebMCP 仍在演进（Chrome 已提示 `navigator.modelContext` 在未来版本迁移到 `document.modelContext`），故工具层是可替换的薄桥，核心业务不绑死在它上面。若日后需要"无浏览器、无人值守批量生成"，另做后端 MCP server（不属于本文范围）。

### 1.1 Schema 抽取机制（维护者须知）

schema 抽取是**逆向追踪**：构建插件扫描 `registerGlobalTools()` / `useWebMcpTools()` 的**调用点**，从那里回溯到被注册的函数定义，再用 ts-morph 解析参数类型 + JSDoc，把 `__webmcpSchema` 注入到**调用点所在文件**（即 `src/mcp/register.ts` 的 `tools.drama_*.__webmcpSchema`），而**不是**注入到 `tools.ts`。因此：

- `register.ts` 用 `import * as tools from "./tools"` 的 namespace import 是必须的——抽取器靠它解析源模块的所有导出函数。
- 插件 `include` 必须覆盖 `register.ts`（当前 `src/mcp/**/*.ts` 即可）。单独 transform `tools.ts` 会因找不到注册调用而 `transformed: false`，这是预期行为。
- 不直接用官方 `vite-plugin-webmcp-nexus`：它在 Windows 上用 `path.relative` 得到反斜杠路径去匹配只认 `/` 的 glob，导致无文件命中、schema 永不注入。本地 `vite-webmcp-plugin.ts` 包装同一个官方 `webmcp-nexus-core`（抽取逻辑不变），只在 include 匹配前把分隔符归一化为 `/`，跨平台一致。

---

## 2. 设计原则（为什么这样切工具）

1. **节点操作 = 工具，而非节点实例 = 工具。** 不把 `video_gen_node_123` 这类节点实例动态注册为工具——会让工具列表膨胀、生命周期失控、语义稀释。工具是一组**稳定的画布命令**。
2. **不暴露巨型入参。** WebMCP Nexus 的类型 schema 抽取只稳定支持基础类型、字面量联合、可选属性、≤3 层浅嵌套对象，不可靠支持泛型（`Record`/`Partial`/`Pick`）与对象数组里的深嵌套对象。因此**不暴露整张 `CanvasGraph` 给 AI**；工具接收少量浅参数，内部组装 `CanvasGraphDTO`。
3. **位置由工具层自动布局，AI 不传坐标。** AI 无视觉反馈，坐标对它无语义。节点坐标由确定性的**分层布局**（按拓扑深度分列）在工具层计算，并按 `nodeId` 缓存以保证 idempotent 重跑时位置稳定。不提供 `position` 入参。
4. **AI 掌控稳定 `nodeId`，与人工 id 隔离命名空间。** 人工节点用模块级计数器 id（`text_gen-1`）；AI 用稳定业务 id（如 `ep01_s001_text`），upsert 按此 id 去重。两者前缀不冲突。
5. **副作用显式。** 查询类工具标 `@readonly`；创建/保存/生成类不标。生成默认走 `mock` 通道，真实 `routin` 必须显式传参（烧钱、排队）。
6. **save-before-run 是硬约束。** 后端 `submit_*` 按 `output_node_id` 在**已持久化**画布里找节点（[03](03_backend_api.md)）。故任何 `run_*` 工具内部必须先 `saveCanvas` 再 submit，否则后端不认识 AI 刚建的节点。
7. **端口类型校验前移。** `connect_nodes` 复用与 UI 护栏（[04 §3.4](04_frontend.md)）、后端拓扑校验（[01 §2.4](01_domain_model.md)）同源的 `NODE_OUTPUT`/`ADAPTER_INPUTS` 规则，非法连接立即返回明确错误，给 AI 即时反馈，不攒出非法图到 submit 才炸。
8. **资产 code↔ref_id 映射归工具。** AI 不知道数字 `ref_id`；`list_assets` 返回 `{id, name, kind, scope}`，`upsert_image_node` 接受 `assetId`/`assetName`，由工具内部解析为 `ref_id`。

---

## 3. 工具清单（分阶段）

工具命名统一 `drama_` 前缀。所有工坊工具**显式传 `episodeId`**（无状态、更安全），不依赖隐藏的"当前 episode"。

### 3.1 第一阶段（演示可用：自然语言搭一个镜头并出片）

| 工具 | readonly | 作用 |
|---|---|---|
| `drama_open_workshop` | | 路由到 `/projects/{projectUid}/episodes/{episodeId}/workshop`（仅导航，不改画布） |
| `drama_list_assets` | ✓ | 列出当前 episode 可见资产，返回 `{id, name, kind, scope}`，供 AI 按名/类型选图 |
| `drama_get_canvas` | ✓ | 返回当前画布的节点/边摘要（id、kind、name、连接关系），供 AI 了解现状 |
| `drama_build_shot_video_graph` | | **高层工具**：接 `episodeId`、`shotId`、镜头提示词、资产引用列表、视频参数，一次性创建文本节点 + 图像节点(按引用) + video_gen 节点 + 连线(含 order) + 自动布局，**只搭图不渲染** |
| `drama_save_canvas` | | 持久化当前画布到后端 |
| `drama_run_video_node` | | 对指定 video_gen 节点 save-then-submit，轮询 job 到终态（默认 `mock` 通道） |
| `drama_get_job` | ✓ | 查询 job 状态 |

`drama_build_shot_video_graph` 入参（浅结构）示意：

```ts
{
  episodeId: number;
  shotId: string;          // 节点 id 命名空间前缀，如 "ep01_s001"
  prompt: string;          // 完整镜头提示词 -> text 节点 -> video_gen
  assetRefs?: Array<{      // 引用的资产（按 order 接入 video_gen）
    assetId?: number;      // 二选一：已知资产 id
    assetName?: string;    // 或按名解析（工具内部映射到 ref_id）
    order?: number;        // 接入次序；省略则按数组顺序
  }>;
  duration?: number;       // 省略走 catalog 默认（ADR-007）
  ratio?: string;          // 省略走 catalog 默认
  resolution?: string;     // 省略走 catalog 默认
  channel?: 'mock' | 'routin';  // 仅 run_* 用；build 不渲染
}
```

> 该工具内部保证：video_gen 至少接入一个**非空文本** text 节点（后端 `hasVideoPromptInput` 要求），否则无法渲染。

### 3.2 第二阶段（细粒度编辑：AI 可修正画布而非每次重建）

> 已实现。这些工具让 AI 增量纠正画布（按稳定 id idempotent upsert），而不是每次重建整张图。

| 工具 | readonly | 作用 |
|---|---|---|
| `drama_upsert_text_node` | | 按稳定 id 新建/更新文本节点（文本内容、可选绑定 segment） |
| `drama_upsert_image_node` | | 按稳定 id 新建/更新图像节点（绑定资产 `assetId`/`assetName`，或上游产物） |
| `drama_upsert_adapter_node` | | 按稳定 id 新建/更新适配器节点（text_gen/image_gen/video_gen） |
| `drama_connect_nodes` | | 连接两节点，按端口类型校验，自动分配/追加 `order` |
| `drama_set_video_params` | | 设置 video_gen 的时长/画面比例/分辨率（catalog 边界校验） |
| `drama_delete_node` | | 删除节点（AI 纠错路径，不只靠 upsert） |
| `drama_run_text_node` | | save-then-submit 文本生成，轮询到终态 |
| `drama_run_image_node` | | save-then-submit 图像生成，轮询到终态 |

### 3.3 后续（视需要）

- 后端 Python MCP server（无浏览器批量生成）——不属于 WebMCP 工具层。
- 临时资产"待登记"语义：当前已可经 `scope=temporary` 的 episode 级资产承载（[ADR-005](00_overview.md#adr-005-资产按全局--项目--单集三层披露)）；可在 build 工具里顺手登记临时资产，暂不新增 `asset_status` 字段。
- 资产业务编号（如 `CH-LIN-38`）：第一阶段用 `id`/`name` 足够；若需稳定外部编号，按"schema 即约束"方向加一等字段 `asset_code`/`external_id`，而非塞 `spec.code`。**这是文档化的未来增强，非当前实现。**

---

## 4. 与前端状态的集成（关键）

WebMCP 工具是构建期抽取的**顶层导出函数**，无法访问 React 组件内的 `useState`。因此画布状态必须放在**模块级 store（zustand）**，工具操作该 store，并复用同一份 `flowToDto` / `saveCanvas` 路径。这同时落实了 [04 §4](04_frontend.md) 早已规定的"画布本地态用 Zustand"。

- `src/stores/canvasStore.ts`：持有 `nodes` / `edges`，暴露业务动作（`upsertTextNode` / `upsertImageNode` / `upsertAdapterNode` / `connectNodes` / `setVideoParams` / `deleteNode` / `buildShotVideoGraph` / `loadFromDto` / `toDto` / `persist` / `runNode` 等；`runNode` 对 text_gen/image_gen/video_gen 通用）。
- `CanvasWorkshop.tsx` 消费该 store（替代组件内 `useNodesState`/`useEdgesState`），UI 与工具操作同一份状态——AI 调用时画布**实时长出节点**，这正是"看着 AI 搭画布"的演示价值所在。
- `src/mcp/tools.ts`：顶层导出的工具函数，调用 `useCanvasStore.getState()` 上的业务动作；带标准 JSDoc + 单对象参数（schema 抽取硬要求）。
- 注册入口：`registerGlobalTools(tools)`（应用启动一次）。

---

## 5. 安全

- 本地 relay 开 WebSocket 桥把页面工具暴露给本地 MCP 客户端。**仅开发期注入 `embed.js`**（dev build / 环境开关），不进生产，relay 只绑 localhost。
- 生成类工具默认 `mock`，真实 `routin` 必须显式传参，避免 AI 误触发烧钱/排队的视频生成。
- 工具把外部传入值写入画布前做基本校验（节点 id 命名空间、资产可见性、端口类型），不信任 AI 直接给的结构。

---

## 6. 非目标

- 不把节点实例动态注册为工具。
- 不暴露整张 `CanvasGraph` 作为单一巨型入参。
- 不让 AI 传节点坐标。
- 第一阶段不做后端 MCP server、不改资产表 schema。
