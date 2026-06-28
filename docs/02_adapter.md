# 02 · 适配层（Adapter）

适配层是后端 core 的"对外插座"。它的唯一职责是：用一组**最小、稳定的生成契约**，把层次不齐的厂商接口抹平，让 pipeline 与 service 层只面对统一的 `generate(...)`，不关心背后是 AgentScope、agent-framework 还是 Volcengine Ark。

设计依据 [ADR-002](00_overview.md#adr-002-适配层抽象最小生成契约由渠道继承)：**只实现必要的"生成"方法与必要参数**，具体厂商继承实现。第一版只接 routin.ai 网关一个渠道，不预先抽象未验证的厂商差异——避免"顺手通用化"带来的维护负担。

---

## 1. 为什么需要这一层

三个 PoC 指向同一个网关 `api.routin.ai`，却用了三套 SDK：

| 能力 | SDK | 调用形态 |
|---|---|---|
| 文本 | AgentScope `Agent.reply_stream` | 流式事件 |
| 图像 | agent-framework `image_generation` tool | 流式 partial-image |
| 视频 | Volcengine Ark `content_generation.tasks` | 异步提交 + 轮询 |

三者的"提交方式""结果形态""参数命名"都不同。如果 pipeline 直接调 SDK，每接一个新厂商就要改一遍 pipeline。适配层把差异锁在边界内：契约对上稳定，实现对下可换。

## 2. 三个生成基类（`src/ai_drama/adapters/base.py`）

基类只定义"必要的生成"。参数取 PoC 已验证的子集——不多、不替厂商预设它没有的能力。请求/响应都是 pydantic 模型，天然可序列化、可入 `GenerationJob.request`。

### 2.1 文本生成

```python
class TextGenRequest(BaseModel):
    input_texts: list[str] = Field(min_length=1)  # TEXT_GEN 的有序文本输入
    system_prompt: str = "You are a helpful assistant."
    model: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    # 推理类模型开关（对齐 textgen.py）
    reasoning_effort: str | None = "medium"

class TextGenResult(BaseModel):
    text: str
    model: str | None = None

class TextAdapter(ABC):
    @abstractmethod
    async def generate(self, req: TextGenRequest) -> TextGenResult: ...
```

`input_texts` 保留画布连线 order 语义，避免多个文本节点接入 TextGen 时只消费第一条。Routin 文本 adapter 使用 AgentScope 的 `reply_stream(Msg | list[Msg])` 语义，把 `input_texts` 按顺序投影为 `list[UserMsg]`，不在 compiler 里拼接成合成 prompt。

### 2.2 图像生成（文生图 / 图文生图）

```python
class ImageRef(BaseModel):
    """参考图：本地路径 / http(s) URL / data: URI（对齐 imagegen2.py 的输入语义）。"""
    ref: str

class ImageContentItem(BaseModel):
    type: Literal["text", "image"]
    text: str | None = None
    image: ImageRef | None = None

class ImageGenRequest(BaseModel):
    ordered_content: list[ImageContentItem]  # 画布输入节点的真实混合顺序
    model: str | None = None
    size: str | None = None              # 1024x1024 / 1024x1536 / 1536x1024 / auto
    quality: str | None = None           # low / medium / high / auto
    output_format: str | None = None     # png / jpeg / webp
    background: str | None = None        # transparent / opaque / auto

class ImageGenResult(BaseModel):
    image_path: str                      # 落盘路径
    size_bytes: int
    response_id: str | None = None

class ImageAdapter(ABC):
    @abstractmethod
    async def generate(self, req: ImageGenRequest, *, out: Path) -> ImageGenResult: ...
```

### 2.3 视频生成（图文生视频，异步）

这是唯一天然异步的能力。基类把"提交"与"轮询"拆成两个方法，直接映射 videogen 的 `generate` / `poll` 双命令——这也是 [ADR-003](00_overview.md#adr-003-异步任务走轻量模型无独立-broker) 可恢复轮询的根。

```python
class VideoSlotKind(StrEnum):
    REFERENCE = "reference_image"   # 参考图槽
    FIRST_FRAME = "first_frame"     # 首帧槽
    LAST_FRAME = "last_frame"       # 尾帧槽

class VideoImageSlot(BaseModel):
    ref: str
    kind: VideoSlotKind = VideoSlotKind.REFERENCE

class VideoContentItem(BaseModel):
    type: Literal["text", "image"]
    text: str | None = None
    image: VideoImageSlot | None = None

class VideoGenRequest(BaseModel):
    ordered_content: list[VideoContentItem]  # 画布输入节点的真实混合顺序
    model: str | None = None
    resolution: str | None = None
    ratio: str | None = None             # 16:9 / 9:16 / 1:1
    duration: int | None = None
    seed: int | None = None
    camera_fixed: bool | None = None
    generate_audio: bool | None = None

    @model_validator(mode="after")
    def _slots_exclusive(self) -> "VideoGenRequest":
        # 对齐 videogen.py 的服务端规则：首/尾帧槽与参考图槽互斥
        kinds = {item.image.kind for item in self.ordered_content if item.image}
        keyframe = {VideoSlotKind.FIRST_FRAME, VideoSlotKind.LAST_FRAME}
        if keyframe & kinds and VideoSlotKind.REFERENCE in kinds:
            raise ValueError("首/尾帧槽不能与参考图槽混用（Ark 服务端规则）")
        return self

class VideoSubmitResult(BaseModel):
    provider_task_id: str                # 渠道侧 task id → GenerationJob.provider_task_id

class VideoPollResult(BaseModel):
    status: str                          # queued/running/succeeded/failed/canceled
    video_url: str | None = None
    error: str | None = None

class VideoAdapter(ABC):
    @abstractmethod
    async def submit(self, req: VideoGenRequest) -> VideoSubmitResult: ...
    @abstractmethod
    async def poll(self, provider_task_id: str) -> VideoPollResult: ...
```

> `ImageGenRequest.ordered_content` / `VideoGenRequest.ordered_content` 是 `CanvasEdge.order` 的 provider-side 投影，也是图像/视频请求里唯一的多模态上下文来源：它保留 text/image 混合顺序，分别投影为 agent-framework 的 `Message.contents` 与 Ark 的 content array。`VideoGenRequest._slots_exclusive` 把 videogen 的服务端约束提前到客户端 schema——错误在构造请求时就暴露，而不是等渠道返回 BadRequest。pipeline 全程只走参考图槽的核心机制），首尾帧槽保留给未来可能的其他渠道。TextGen 的 `input_texts` 采用同一条 order 语义，Routin 通道最终投影为 AgentScope 的 `list[UserMsg]`。`duration` / `resolution` 的默认值与可选范围不写在 adapter contract 中，而由 [ADR-007](00_overview.md#adr-007-模型参数约束以-catalog-yaml-为真源运行时只消费-pydantic-视图) 的 typed model catalog view 在画布编译阶段填入。

## 3. routin 实现（`src/ai_drama/adapters/routin/`）

第一版的唯一渠道，继承三个基类，内部分别复用 PoC 已验证的调用方式：

```
adapters/
├─ base.py                 # 三个 ABC + 请求/响应 schema
├─ registry.py             # 渠道注册表：name -> adapter 工厂
└─ routin/
   ├─ text.py              # RoutinTextAdapter   ← AgentScope OpenAIChatModel
   ├─ image.py             # RoutinImageAdapter  ← agent-framework OpenAIChatClient
   └─ video.py             # RoutinVideoAdapter  ← Volcengine Ark Runtime
```

每个实现只做三件事：把 `*GenRequest` 翻译成 SDK 入参、调 SDK、把结果收敛回 `*GenResult`。PoC 脚本里的纯函数的 `_image_ref_to_content` / `_save_data_uri`、videogen 的 `_build_content` / `_image_ref_to_url`）可直接搬进对应实现的私有方法，保留 PoC 已踩过的坑（如 Ark image content 必填 `role`、本地图内联为 base64 data URI）。

工程版还要处理一个前后端边界：生成图片返回给前端的是浏览器预览 URL（如 `/images/xxx.webp`），而图生图 / 图文生视频适配器需要的是可读本地文件或远端可访问 URL。因此 routin adapter 在真正组装 provider 请求前，会把后端自身的 `/images/...` 静态 URL 还原到 `outputs/images/...` 再内联为 data URI；不要把 `/images/...` 当作文件系统根目录路径。图像生成 job 会先把 provider 原图归档到 `outputs/images/raw/`，再由 service 层用 Pillow 生成几百 KB 量级的工作副本写到 `outputs/images/` 根目录；前端预览、画布持久化、后续 ImageGen / VideoGen 节点都只使用压缩后的工作副本，raw 仅用于归档和人工追溯。

配置（base_url / api_key / 默认模型）从 pydantic-settings 注入，不再硬编码：

```python
# config.py
class RoutinSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ROUTIN_", env_file=".env")
    api_key: str
    text_base_url: str = "https://api.routin.ai/v1"
    image_base_url: str = "https://api.routin.ai/v1"
    video_base_url: str = "https://api.routin.ai/api/v3"
    text_model: str = "deepseek-v4-pro"
    image_model: str = "gpt-5.4"
    video_model: str = "doubao-seedance-2-0-fast-260128"
```

## 4. 注册表与选择（为扩展留位，不预造框架）

`registry.py` 是一个简单的字典工厂，不是插件框架——符合"轻装主义"。第一版只注册 `routin`：

```python
_TEXT: dict[str, Callable[[], TextAdapter]] = {"routin": RoutinTextAdapter}
_IMAGE: dict[str, Callable[[], ImageAdapter]] = {"routin": RoutinImageAdapter}
_VIDEO: dict[str, Callable[[], VideoAdapter]] = {"routin": RoutinVideoAdapter}

def get_text_adapter(channel: str = "routin") -> TextAdapter: ...
def get_image_adapter(channel: str = "routin") -> ImageAdapter: ...
def get_video_adapter(channel: str = "routin") -> VideoAdapter: ...
```

接入新厂商（如直接走 xAI）只需：新建 `adapters/xai/video.py` 继承 `VideoAdapter`，在 `_VIDEO` 注册一行。pipeline、service、API 全不动——这就是 ADR-002 的扩展承诺。

## 5. 与上层的衔接

- **CanvasGraph 编译产物**就是 `TextGenRequest` / `ImageGenRequest` / `VideoGenRequest`（见 [01 §2.4](01_domain_model.md)）。画布的有序连线在 TextGen 中编译为 `input_texts`，在 ImageGen / VideoGen 中编译为 `ordered_content` 的真实上下文顺序。
- **pipeline 阶段**调对应 adapter：06 分镜用 `TextAdapter` 产 StoryboardJSON；04/05 资产用 `ImageAdapter`；08 用 `VideoAdapter`。
- **异步落点**：`VideoAdapter.submit` 返回的 `provider_task_id` 存入 `GenerationJob`，由后端任务层轮询（见 [03 后端接口与任务](03_backend_api.md)）。

## 6. 边界与非目标

- 适配层**不做**业务编排、不做重试策略框架、不做 job 状态管理——那些在 service / 任务层。adapter 只负责"翻译一次调用"。
- 不预先为"所有厂商参数的并集"建模。基类字段是 PoC 验证过的交集 + 必要项；某厂商独有的高级参数，等真正接入时再在其子类扩展，不污染基类。
- 流式细节（textgen 的 token 流、imagegen 的 partial-image）在 adapter 内部消化，对上只暴露最终结果；若未来需要把流式透传到前端，再单独设计 streaming 接口，不在第一版基类里预留。
