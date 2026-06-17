# 02 · 适配层（Adapter）

适配层是后端 core 的"对外插座"。它的唯一职责是：用一组**最小、稳定的生成契约**，把层次不齐的厂商接口抹平，让 pipeline 与 service 层只面对统一的 `generate(...)`，不关心背后是 AgentScope、agent-framework 还是 Volcengine Ark。

设计依据 [ADR-002](00_overview.md#adr-002-适配层抽象最小生成契约由渠道继承)：**只实现必要的"生成"方法与必要参数**，具体厂商继承实现。第一版只接 routin.ai 网关一个渠道，不预先抽象未验证的厂商差异——避免"顺手通用化"带来的维护负担。

---

## 1. 为什么需要这一层

三个 PoC 指向同一个网关 `api.routin.ai`，却用了三套 SDK：

| 能力 | PoC | SDK | 调用形态 |
|---|---|---|---|
| 文本 | [textgen.py](../test/textgen.py) | AgentScope `Agent.reply_stream` | 流式事件 |
| 图像 | [imagegen2.py](../test/imagegen2.py) | agent-framework `image_generation` tool | 流式 partial-image |
| 视频 | [videogen.py](../test/videogen.py) | Volcengine Ark `content_generation.tasks` | 异步提交 + 轮询 |

三者的"提交方式""结果形态""参数命名"都不同。如果 pipeline 直接调 SDK，每接一个新厂商就要改一遍 pipeline。适配层把差异锁在边界内：契约对上稳定，实现对下可换。

## 2. 三个生成基类（`src/ai_drama/adapters/base.py`）

基类只定义"必要的生成"。参数取 PoC 已验证的子集——不多、不替厂商预设它没有的能力。请求/响应都是 pydantic 模型，天然可序列化、可入 `GenerationJob.request`。

### 2.1 文本生成

```python
class TextGenRequest(BaseModel):
    prompt: str
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

### 2.2 图像生成（文生图 / 图文生图）

```python
class ImageRef(BaseModel):
    """参考图：本地路径 / http(s) URL / data: URI（对齐 imagegen2.py 的输入语义）。"""
    ref: str

class ImageGenRequest(BaseModel):
    prompt: str
    images: list[ImageRef] = []          # 空=文生图；非空=图文生图（编辑/引导）
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

这是唯一天然异步的能力。基类把"提交"与"轮询"拆成两个方法，直接映射 [videogen.py](../test/videogen.py) 的 `generate` / `poll` 双命令——这也是 [ADR-003](00_overview.md#adr-003-异步任务走轻量模型无独立-broker) 可恢复轮询的根。

```python
class VideoSlotKind(StrEnum):
    REFERENCE = "reference_image"   # 参考图槽
    FIRST_FRAME = "first_frame"     # 首帧槽
    LAST_FRAME = "last_frame"       # 尾帧槽

class VideoImageSlot(BaseModel):
    ref: str
    kind: VideoSlotKind = VideoSlotKind.REFERENCE

class VideoGenRequest(BaseModel):
    prompt: str
    images: list[VideoImageSlot] = []    # 参考图按 08 固定顺序排列
    model: str | None = None
    resolution: str | None = None        # 480p / 720p / 1080p
    ratio: str | None = None             # 16:9 / 9:16 / 1:1
    duration: int | None = None          # 秒，≥4（与 segment ≤15 协同）
    seed: int | None = None
    camera_fixed: bool | None = None
    generate_audio: bool | None = None

    @model_validator(mode="after")
    def _slots_exclusive(self) -> "VideoGenRequest":
        # 对齐 videogen.py 的服务端规则：首/尾帧槽与参考图槽互斥
        kinds = {s.kind for s in self.images}
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

> `VideoGenRequest._slots_exclusive` 把 [videogen.py:340](../test/videogen.py#L340) 的服务端约束提前到客户端 schema——错误在构造请求时就暴露，而不是等渠道返回 BadRequest。pipeline 全程只走参考图槽（[08](../test/instructions/08_视频生成执行.md) 的核心机制），首尾帧槽保留给未来可能的其他渠道。

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

每个实现只做三件事：把 `*GenRequest` 翻译成 SDK 入参、调 SDK、把结果收敛回 `*GenResult`。PoC 脚本里的纯函数（如 [imagegen2.py](../test/imagegen2.py) 的 `_image_ref_to_content` / `_save_data_uri`、[videogen.py](../test/videogen.py) 的 `_build_content` / `_image_ref_to_url`）可直接搬进对应实现的私有方法，保留 PoC 已踩过的坑（如 Ark image content 必填 `role`、本地图内联为 base64 data URI）。

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

接入新厂商（如直接走 xAI，对应 [videogen-xai.py](../test/videogen-xai.py)）只需：新建 `adapters/xai/video.py` 继承 `VideoAdapter`，在 `_VIDEO` 注册一行。pipeline、service、API 全不动——这就是 ADR-002 的扩展承诺。

## 5. 与上层的衔接

- **CanvasGraph 编译产物**就是 `VideoGenRequest`（见 [01 §2.4](01_domain_model.md)）。画布的有序连线编译成 `images` 列表的固定顺序（`@图1人物 @图2分镜资产 @图3场景 @图4道具`）。
- **pipeline 阶段**调对应 adapter：06 分镜用 `TextAdapter` 产 StoryboardJSON；04/05 资产用 `ImageAdapter`；08 用 `VideoAdapter`。
- **异步落点**：`VideoAdapter.submit` 返回的 `provider_task_id` 存入 `GenerationJob`，由后端任务层轮询（见 [03 后端接口与任务](03_backend_api.md)）。

## 6. 边界与非目标

- 适配层**不做**业务编排、不做重试策略框架、不做 job 状态管理——那些在 service / 任务层。adapter 只负责"翻译一次调用"。
- 不预先为"所有厂商参数的并集"建模。基类字段是 PoC 验证过的交集 + 必要项；某厂商独有的高级参数，等真正接入时再在其子类扩展，不污染基类。
- 流式细节（textgen 的 token 流、imagegen 的 partial-image）在 adapter 内部消化，对上只暴露最终结果；若未来需要把流式透传到前端，再单独设计 streaming 接口，不在第一版基类里预留。
