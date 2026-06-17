# AI Drama Flow

AI 短剧 / 漫剧生产平台。把"小说 / 剧情 → 视频"的链路工程化为一个有数据模型、适配层、前后端的可迭代系统。

## 目录

```
docs/       设计文档（00–05）
backend/    Python 后端 core（uv · FastAPI · Typer · SQLAlchemy · pydantic）
frontend/   TypeScript 前端（Vite · React · react-i18next · TanStack Query）
test/       原 PoC 脚本与 pipeline instructions（保留作参考与迁移基准）
```

## 本地运行

### 后端

```bash
cd backend
uv sync                              # 安装依赖（mock 渠道无需密钥）
# uv sync --extra routin             # 需要真实视频渠道时，额外装 Volcengine Ark SDK
cp .env.example .env                 # 填入 ROUTIN_API_KEY（仅 routin 渠道需要）
uv run ai-drama --help               # 查看 CLI
uv run ai-drama seed-demo            # ★ 一键端到端：建项目→资产→分集→分镜→画布→出片(mock)
uv run ai-drama serve                # 启动 FastAPI（默认 http://127.0.0.1:8770）
```

`seed-demo` 用离线 mock 渠道在无网络、无密钥下跑通整条链路，输出一段占位 MP4 的路径——最快验证后端切片是否完整。真实出片把 `--channel routin` 传入（需先 `uv sync --extra routin` 并配好 `.env`）。

### 前端

```bash
cd frontend
npm install
npm run dev                          # 默认 http://localhost:5173
```

打开浏览器：创建项目 → 打开项目（加人物 / 场景资产、建分集）→ 进入 EP 工坊。在工坊里：

1. 从左侧节点面板拖出「图像」「文本」「视频生成」节点。
2. 在图像节点引用人物 / 场景资产，在文本节点填写镜头提示词。
3. 把图像节点和文本节点连入「视频生成」节点——连线上的数字就是上下文顺序。
4. 选中「视频生成」节点，按需要调整视频时长与分辨率。
5. 点「生成视频」——前端轮询任务状态，成功后在生成节点内嵌播放视频（mock 渠道为占位片）。

> 画布会在交互层就阻止非法连线（资产节点只能连向内容 / 输出，输出节点是汇点，不成环）——这是前端"约束用户不越界"的第一道护栏，后端 schema 是最终防线。

> **端口说明**：默认后端端口是 **8770** 而非常见的 8000。本机（Windows）的 TCP 端口 7992–8091 被系统保留（`netsh interface ipv4 show excludedportrange protocol=tcp` 可查），8000 无法绑定。如需改端口：后端 `uv run ai-drama serve --port <port>`，前端在 `frontend/.env` 设 `VITE_API_BASE_URL`。

## 测试

```bash
cd backend && uv run pytest -q       # schema 不变量 / 画布编译 / 异步 job 端到端（mock，13 用例）
```

## 安全

API 密钥统一走 `backend/.env`（已 gitignore），不硬编码、不入库。FastAPI 当前无鉴权，仅供本地使用；若日后暴露到网络须先补鉴权。
