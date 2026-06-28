# 01 · 领域模型

数据模型是整个系统的地基。本文把 pipeline 的阶段契约落成两层：**pydantic schema**（序列化、校验、前后端契约）与 **SQLAlchemy ORM**（持久化、可迁移）。两层职责分离——pydantic 是"对外的形状"，ORM 是"落盘的形状"，service 层负责在两者间转换。

设计取向遵循"schema 即约束"：把数据模型本身当作护栏，用类型化字段、validator、computed field 把"无穷多种正确路径"收敛到 pipeline 能消费的一条。下游 agent 与前端画布都不应绕过这些约束自造结构。

---

## 1. 实体关系总览

```
Project (一部剧)
 ├─ uid                稳定公开标识，用于 URL / API project path，不暴露自增 id
 ├─ StoryDigest        1:1   故事摘要（01 产出）
 ├─ CharacterBible     1:1   人物圣经（02 产出）
 ├─ WorldBible         1:1   世界圣经（02 产出）
 ├─ EpisodeMap         1:1   分集总表（02 产出）
 ├─ Asset              1:N   项目固定视觉资产（人物/道具/场景）
 │   └─ image_path           生成的参考图（04/05 产出，可指向全局源）
 └─ Episode            1:N   分集
     ├─ EpisodeScript  1:1   单集剧本（03 产出）
     ├─ Storyboard     1:1   分集分镜 JSON（06 产出）
     │   └─ Segment    1:N   镜头碎片（每段 ≤15s）★最小单元
     │       ├─ StoryboardPanel  1:1  草稿分镜板（07 产出）
     │       └─ Clip            1:1  视频段（08 产出）
     └─ CanvasGraph    1:1   EP 工坊画布（自由编排 DAG，ADR-001）
         ├─ CanvasNode  1:N
         └─ CanvasEdge  1:N  （有序连线）

Asset                  全局资产可不挂 Project；临时资产可挂 Episode
GenerationJob          独立表，异步任务状态（ADR-003），可挂在任意可生成实体上
```

**资产三层披露**（ADR-005）：`Asset.scope` 分为 `global` / `fixed` / `temporary`。全局资产 `project_id=None, episode_id=None`，可被任意项目和分集引用；项目固定资产 `project_id=<Project.id>, episode_id=None`，只在所属项目可见；单集临时资产 `project_id=<Project.id>, episode_id=<Episode.id>`，只在当前 EP 工坊可见。`source_asset_id` 允许项目/临时资产指向同一个全局源资产。service 层编译画布时按 episode 校验可见性：只能引用“全局 + 当前项目固定 + 当前单集临时”。

**Segment 边界**：`Episode 1:N Segment` 是为未来逐段出片保留的结构关系。当前阶段不要求 `Episode` 预设固定总时长，也不从总时长推导 segment 数量；`Segment.duration_sec` 只表达单段视频的建议长度，默认 15s，并保留 `≤15s` 的单段硬上限。

## 2. pydantic 层（`src/ai_drama/models/`）

### 2.1 枚举与公共类型

把 06 schema 里的字符串枚举全部类型化，避免下游拼写漂移。

```python
# models/enums.py
from enum import StrEnum

class AssetKind(StrEnum):
    CHARACTER = "character"
    PROP = "prop"
    SCENE = "scene"

class AssetScope(StrEnum):
    GLOBAL = "global"       # 全局可复用源
    FIXED = "fixed"         # 当前项目固定资产
    TEMPORARY = "temporary" # 当前单集临时资产

class ShotType(StrEnum):
    WIDE = "wide"
    MEDIUM = "medium"
    MEDIUM_CLOSE_UP = "medium_close_up"
    CLOSE_UP = "close_up"
    EXTREME_CLOSE_UP = "extreme_close_up"

class CameraMovement(StrEnum):
    STATIC = "static"
    SLOW_PUSH_IN = "slow_push_in"
    SLOW_PULL_OUT = "slow_pull_out"
    PAN_LEFT = "pan_left"
    PAN_RIGHT = "pan_right"
    TILT_UP = "tilt_up"
    TILT_DOWN = "tilt_down"
    HANDHELD_FOLLOW = "handheld_follow"
    WHIP_PAN = "whip_pan"
    ORBIT = "orbit"
    ARC_AROUND_SUBJECT = "arc_around_subject"
    CRANE_DOWN = "crane_down"
    DOLLY_ZOOM = "dolly_zoom"
    OVER_SHOULDER = "over_shoulder"
    REVERSE_SHOT = "reverse_shot"

class TransitionType(StrEnum):
    OPENING = "opening"
    SAME_SCENE_CUTAWAY = "same_scene_cutaway"
    INSERT_DETAIL = "insert_detail"
    TIME_ELLIPSIS_CUT = "time_ellipsis_cut"
    MATCH_ACTION = "match_action"
    MATCH_CUT = "match_cut"
    OBJECT_MATCH = "object_match"
    WALK_THROUGH = "walk_through"
    DOOR_OPEN = "door_open"
    WHIP_PAN_MOTION = "whip_pan_motion"
    J_CUT_AUDIO = "j_cut_audio"
    L_CUT_AUDIO = "l_cut_audio"
    WHITE_FLASH = "white_flash"
    BLACK_DIP = "black_dip"
    ENVIRONMENTAL_SWEEP = "environmental_sweep"
    REVERSE_SHOT_PAIR = "reverse_shot_pair"
    OVER_SHOULDER_PAIR = "over_shoulder_pair"
    NONE_SAME_SCENE = "none_same_scene"

# 镜头语言完整枚举集（spatial_anchor / screen_anchor 的受控词表）
# 同样以 StrEnum 落地，此处略，详见 06 §2 schema。
```

> 说明：把 06 的镜头术语库做成枚举，是"schema 即约束"最直接的体现——视频提示词里的镜头语言只能从受控词表取值，杜绝 agent 自由发挥导致下游解析失败。

### 2.2 阶段产出 schema（01 → 06 数据契约）

每个阶段一个 pydantic 模型，字段直接对齐 instructions。这里给出最关键的几个；完整字段以对应 instruction 文件为单一事实源。

```python
# models/story.py —— 01 StoryDigest
class CoreCharacter(BaseModel):
    name: str
    surface_desire: str          # 明面欲望
    hidden_desire: str           # 暗面欲望
    weakness: str                # 软肋
    source_anchor: str           # 原文锚点

class StoryDigest(BaseModel):
    genre_anchor: str            # 题材锚点 + 主导爽点
    core_characters: list[CoreCharacter]
    relation_graph: str
    main_thread: str
    subplot_threads: list[str] = []
    pivotal_beats: list[str]
    filmable_segments: list[FilmableSegment]
    notes: str = ""
```

```python
# models/bible.py —— 02 CharacterBible / WorldBible / EpisodeMap

class CharacterVisualAnchor(BaseModel):
    """给 04 角色设计师的硬约束（不可漂移项）。
    写'气质忧郁'无效，写'左眉 0.8cm 旧伤疤 + 石青色立领'才是硬约束。"""
    silhouette: str              # 体型剪影
    key_garment: str             # 标志服饰
    hero_prop: str | None = None # 标志道具
    palette: list[str]           # 主色板 Hex+命名
    fatal_features: list[str]    # 致命特征（疤痕/假眼/缺指）

class CharacterBibleEntry(BaseModel):
    name: str
    one_line: str                # 一句话定位
    portrait: str                # 人物画像
    surface_desire: str
    hidden_desire: str
    traits: list[str]            # 性格关键词
    weakness: str
    arc: str                     # 人物弧光
    visual_anchor: CharacterVisualAnchor

class SceneSpec(BaseModel):
    name: str
    drama_function: str
    scene_name_candidates: list[str]   # 三段式 建筑.区域.方位
    visual_anchor: str                 # 风格/色温/关键道具/光源
    focal_object: str | None = None    # 仪式性核心物

class EpisodeMapRow(BaseModel):
    episode_id: int
    one_line_thread: str         # 一句话主线 → 03 的最小输入
    hook_type: str
    payoff_or_twist: str
    ending_suspense: str
```

```python
# models/storyboard.py —— 06 StoryboardJSON（最严格的契约）

class SpatialAnchor(BaseModel):
    landmarks: list[str]
    depth_layout: str
    character_position: str
    movement_vector: MovementVector       # 深入/折返/横移/静止/出场/入场
    movement_target: str
    focal_object: str | None
    character_facing: str
    camera_solution: str

class ScreenAnchor(BaseModel):
    continuity_group: str
    action_axis: str
    camera_side: CameraSide
    subject_screen_region: ScreenRegion
    facing_screen_direction: FacingDirection
    background_screen_region: str
    primary_prop_regions: dict[str, str] = {}
    allowed_delta_from_prev: AllowedDelta
    axis_crossing_allowed: bool = False

class Segment(BaseModel):
    segment_id: int
    duration_sec: int = Field(default=15, le=15, gt=0)   # §0.1 硬约束：≤15s
    scene_name: str                          # 三段式
    shot_type: ShotType
    camera_movement: CameraMovement
    spatial_anchor: SpatialAnchor
    screen_anchor: ScreenAnchor
    transition_from_prev: TransitionFromPrev | None = None
    key_visual_elements: list[str] = []
    dialogue: list[DialogueLine] = []
    sfx: list[str] = []
    lip_sync: bool = True
    safety_treatment: str = "none"
    visual_prompt: str

class StoryboardJSON(BaseModel):
    episode_id: int
    title: str
    temporary_assets: list[TemporaryAsset] = []
    segments: list[Segment]

    @model_validator(mode="after")
    def _check_invariants(self) -> "StoryboardJSON":
        ids = [s.segment_id for s in self.segments]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate segment_id within storyboard")
        return self
```

> 当前 `_check_invariants` 只维护局部结构一致性，例如同一集内 `segment_id` 不重复。段数规划属于 06 分镜阶段的产出质量问题，不再通过 Episode 固定总时长字段在模型层提前闭合。

### 2.3 CanvasGraph：通用计算图节点（ADR-001 + ADR-006）

自由编排画布是前端一等公民，也是"前端约束用户不越界"的落点。节点是一个**继承体系**（ADR-006）：基类 `Node` 只含公共字段，派生出数据节点与适配器节点。适配器节点 1:1 映射 [02 适配层](02_adapter.md) 的三个 adapter 基类。

```python
# models/canvas.py
class PortType(StrEnum):
    """端口/数据类型，连线时按此校验兼容性。"""
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"

class NodeKind(StrEnum):
    # 数据节点（DataNode）：承载一个值
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    # 适配器节点（AdapterNode）：一次生成，对应 02 的三个 adapter
    TEXT_GEN = "text_gen"     # 文 → 文
    IMAGE_GEN = "image_gen"   # 文 + 多图(可选) → 图
    VIDEO_GEN = "video_gen"   # 文 + 多图(可选) → 视频

# 每种节点的输出类型；适配器节点的输出 = 其产物数据类型
NODE_OUTPUT_TYPE: dict[NodeKind, PortType] = {
    NodeKind.TEXT: PortType.TEXT,
    NodeKind.IMAGE: PortType.IMAGE,
    NodeKind.VIDEO: PortType.VIDEO,
    NodeKind.TEXT_GEN: PortType.TEXT,
    NodeKind.IMAGE_GEN: PortType.IMAGE,
    NodeKind.VIDEO_GEN: PortType.VIDEO,
}

# 适配器节点接受的输入类型（数据节点无输入口）
ADAPTER_INPUT_TYPES: dict[NodeKind, set[PortType]] = {
    NodeKind.TEXT_GEN: {PortType.TEXT},
    NodeKind.IMAGE_GEN: {PortType.TEXT, PortType.IMAGE},
    NodeKind.VIDEO_GEN: {PortType.TEXT, PortType.IMAGE},
}

class CanvasNodePosition(BaseModel):
    x: float = 0.0
    y: float = 0.0
    width: float | None = None     # 可选：用户调整后的节点宽度
    height: float | None = None    # 可选：用户调整后的节点高度

class CanvasNode(BaseModel):
    """对应 Node 继承体系的扁平 DTO（kind 区分子类型）。

    基类语义：每个节点都有 id / name / position / data。``position`` 是
    节点几何信息的唯一入口，``x`` / ``y`` 必填，``width`` / ``height``
    成对可选；不要把 UI 尺寸继续塞进 ``data``。``ref_id`` 让 ImageNode
    引用当前 episode 可见 Asset（全局 / 项目 / 本集临时，人物/道具/场景语义由
    Asset.kind 承载），或让内容型 TextNode 绑定某个 Segment。
    """
    id: str
    kind: NodeKind
    name: str = ""
    ref_id: int | None = None      # ImageNode→Asset.id / TextNode→Segment.id
    position: CanvasNodePosition = Field(default_factory=CanvasNodePosition)
    data: dict = {}                # 文本值 / 生成参数覆盖 等

class CanvasEdge(BaseModel):
    id: str
    source: str                    # CanvasNode.id（取其输出端口）
    target: str                    # CanvasNode.id（适配器节点的输入端口）
    order: int = 0                 # ★有序输入：同一 target 的多条入边按 order 排序

class CanvasGraph(BaseModel):
    episode_id: int
    nodes: list[CanvasNode]
    edges: list[CanvasEdge]

    @model_validator(mode="after")
    def _validate_topology(self) -> "CanvasGraph":
        by_id = {n.id: n for n in self.nodes}
        # 护栏 1：边端点必须存在
        for e in self.edges:
            if e.source not in by_id or e.target not in by_id:
                raise ValueError(f"edge {e.id} 端点不存在")
        # 护栏 2：无环（DAG）
        # 护栏 3：端口类型兼容——source 的输出类型必须落在 target（适配器节点）
        #         的接受输入类型集合内；数据节点不接受输入。
        for e in self.edges:
            src, tgt = by_id[e.source], by_id[e.target]
            if tgt.kind not in ADAPTER_INPUT_TYPES:
                raise ValueError(f"{tgt.kind} 是数据节点，不接受输入")
            out_type = NODE_OUTPUT_TYPE[src.kind]
            if out_type not in ADAPTER_INPUT_TYPES[tgt.kind]:
                raise ValueError(
                    f"类型不兼容：{src.kind}({out_type}) → {tgt.kind}"
                )
        return self
```

> 连线校验从"哪种资产能连哪种节点"的 ad-hoc 规则，升级为**端口类型兼容**：每个适配器节点声明它接受的输入类型集合，连线时比对 source 的输出类型。这更真、更通用——TextGen 只收 text，ImageGen/VideoGen 收 text + image，新增适配器只需在两张表里登记其输入/输出类型。

#### 2.4 图 → pipeline 输入的编译规则

画布是"用户看到的形状"，适配器需要的是"有序的输入 + 参数"。编译以**适配器节点**为单位（ADR-006）：

1. 选定一个适配器节点（如某个 `VIDEO_GEN`），回溯其所有入边。
2. 按 `CanvasEdge.order` 升序排列入边，得到**有序输入**——这正对应 08 阶段的参考图固定顺序（`@图1人物 @图2分镜资产 @图3场景 @图4道具`。顺序直接作用在 adapter 的最终多模态 `content` 上。
3. 按输入类型分流并保留混合顺序：`TEXT` 输入提供 prompt/content text；`TEXT_GEN` 会按顺序收集所有文本输入到 `input_texts`，由支持多消息上下文的 adapter（如 AgentScope Routin adapter）投影为 `list[UserMsg]`。`IMAGE_GEN` / `VIDEO_GEN` 都会把 `CanvasEdge.order` 编译成 `ordered_content`，用于 provider 侧的真实多模态上下文顺序；同时读取上游文本节点当前保存的 `visual_prompt/text`。`IMAGE` 输入提供参考图 content（来自 `ImageNode` 引用的当前 episode 可见 `Asset.image_path` 或上游 ImageGen 产物）。各图引用的 `Asset.kind` 承载人物/场景/道具语义。
4. 编译产物是对应的 `TextGenRequest` / `ImageGenRequest` / `VideoGenRequest`（见 [02 适配层](02_adapter.md)），直接喂给对应 adapter。

> 连线顺序即上下文顺序，是需求方的明确要求；`order` 字段是它的载体，在适配器节点处体现为"第 1 个接入、第 2 个接入…"的有序输入清单。编译规则把"自由 DAG"安全降维成"adapter 的结构化输入"，是 ADR-001/006 权衡里"约束护栏"的具体实现。

## 3. SQLAlchemy ORM 层（`src/ai_drama/db/`）

ORM 用 SQLAlchemy 2.x 声明式风格（`Mapped` / `mapped_column`）。复杂的结构化字段（如整个 `StoryboardJSON`、`CanvasGraph`）以 **JSON 列**落盘——前期 SQLite 用 `JSON` 类型，service 层读写时用对应 pydantic 模型做序列化/反序列化校验。这样既保留关系型主干（可查询、可外键），又不必为每个深层嵌套字段拆十几张表。

```python
# db/models.py
class Base(DeclarativeBase): ...

class Project(Base):
    __tablename__ = "project"
    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[str] = mapped_column(unique=True, index=True)  # URL/API 用公开稳定标识
    title: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(default=func.now())
    # 1:1 阶段产出以 JSON 列内联（前期），或拆独立表（后期）
    story_digest: Mapped[dict | None] = mapped_column(JSON, default=None)
    character_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    world_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    episode_map: Mapped[dict | None] = mapped_column(JSON, default=None)
    assets: Mapped[list["Asset"]] = relationship(back_populates="project")
    episodes: Mapped[list["Episode"]] = relationship(back_populates="project")

class Asset(Base):
    """三层披露的视觉资产（ADR-005）。"""
    __tablename__ = "asset"
    id: Mapped[int] = mapped_column(primary_key=True)
    # global: project_id=None, episode_id=None
    # fixed: project_id=<Project.id>, episode_id=None
    # temporary: project_id=<Project.id>, episode_id=<Episode.id>
    project_id: Mapped[int | None] = mapped_column(ForeignKey("project.id"), index=True)
    episode_id: Mapped[int | None] = mapped_column(ForeignKey("episode.id"), index=True)
    source_asset_id: Mapped[int | None] = mapped_column(ForeignKey("asset.id"), index=True)
    kind: Mapped[str]                       # AssetKind
    name: Mapped[str]
    spec: Mapped[dict] = mapped_column(JSON)        # 视觉锚点 / asset_scope 等
    image_path: Mapped[str | None] = None           # 生成的参考图（04/05 产出）
    created_at: Mapped[datetime] = mapped_column(default=func.now())
    project: Mapped["Project"] = relationship(back_populates="assets")
    episode: Mapped["Episode"] = relationship(back_populates="assets")

class Episode(Base):
    __tablename__ = "episode"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("project.id"))
    episode_no: Mapped[int]                 # EP01 的 01
    title: Mapped[str]
    script: Mapped[dict | None] = mapped_column(JSON, default=None)       # EpisodeScript
    storyboard: Mapped[dict | None] = mapped_column(JSON, default=None)   # StoryboardJSON
    canvas: Mapped[dict | None] = mapped_column(JSON, default=None)       # CanvasGraph
    assets: Mapped[list["Asset"]] = relationship(back_populates="episode")
    segments: Mapped[list["SegmentRow"]] = relationship(back_populates="episode")

class SegmentRow(Base):
    __tablename__ = "segment"
    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episode.id"))
    segment_id: Mapped[int]                 # 集内序号
    duration_sec: Mapped[int]
    spec: Mapped[dict] = mapped_column(JSON)            # 完整 Segment schema
    panel_path: Mapped[str | None] = None              # 07 草稿分镜板
    clip_path: Mapped[str | None] = None               # 08 视频段

class GenerationJob(Base):
    __tablename__ = "generation_job"
    id: Mapped[str] = mapped_column(primary_key=True)  # 内部 job id (uuid)
    kind: Mapped[str]                       # text / image / video
    status: Mapped[str]                     # queued/running/succeeded/failed/canceled
    target_table: Mapped[str]               # 关联实体表名
    target_id: Mapped[int]
    provider_task_id: Mapped[str | None] = None        # 渠道侧 task id（用于恢复轮询）
    request: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict | None] = mapped_column(JSON, default=None)
    error: Mapped[str | None] = None
    created_at: Mapped[datetime] = mapped_column(default=func.now())
    updated_at: Mapped[datetime] = mapped_column(default=func.now(), onupdate=func.now())
```

> `GenerationJob.provider_task_id` 直接对应 videogen 的 `poll` 命令思路：本地轮询被打断时，任务在渠道侧继续跑，凭这个 id 恢复。这是 ADR-003"重启可恢复"的字段支撑。

### 3.1 JSON 列 vs 拆表的取舍

前期把 1:1 的阶段产出（StoryDigest / Bible / StoryboardJSON / CanvasGraph）以 JSON 列内联，理由：

- 这些是**整体读写**的文档，很少做字段级查询；JSON 列避免十几张关联表的连接开销与迁移负担。
- pydantic 模型已经是这些 JSON 的 schema 与校验器，ORM 不必重复建模。
- `Segment` 单独拆 `segment` 表，因为它要被画布节点 `ref_id` 引用、要挂 `panel_path`/`clip_path`、要单独跑生成任务——有独立的关系与生命周期，值得成表。

后期若出现字段级查询需求（如"查所有用了某道具的 segment"），再用 Alembic 迁移拆表。ORM 选型的全部意义就是让这种迁移成本可控。

## 4. 校验责任分层

| 校验 | 落点 | 例 |
|---|---|---|
| 字段类型 / 枚举 | pydantic 字段 | `duration_sec: int = Field(default=15, le=15)` |
| 单实体不变量 | pydantic `model_validator` | segment_id 去重、DAG 无环 |
| 跨实体一致性 | service 层 | 资产引用存在、ImageNode 引用资产对当前 episode 可见、segment 引用归属正确 |
| 持久化约束 | ORM / DB | 外键、唯一约束 |

原则：能在 pydantic 层锁的就不下沉到 service，能在 schema 锁的就不靠约定——与用户"把不变量集中在数据模型本身"的偏好一致。
