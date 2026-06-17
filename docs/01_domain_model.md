# 01 · 领域模型

数据模型是整个系统的地基。本文把 [pipeline](../test/instructions/00_pipeline.md) 的阶段契约落成两层：**pydantic schema**（序列化、校验、前后端契约）与 **SQLAlchemy ORM**（持久化、可迁移）。两层职责分离——pydantic 是"对外的形状"，ORM 是"落盘的形状"，service 层负责在两者间转换。

设计取向遵循"schema 即约束"：把数据模型本身当作护栏，用类型化字段、validator、computed field 把"无穷多种正确路径"收敛到 pipeline 能消费的一条。下游 agent 与前端画布都不应绕过这些约束自造结构。

---

## 1. 实体关系总览

```
Asset (全局视觉资产：人物/道具/场景，ADR-005)   ★不隶属任何项目
 ├─ source_project_id  可空，记录最初由哪个项目的 02 Bible 生成（可追源）
 └─ image_path         生成的参考图（04/05 产出）

Project (一部剧)
 ├─ StoryDigest        1:1   故事摘要（01 产出）
 ├─ CharacterBible     1:1   人物圣经（02 产出）
 ├─ WorldBible         1:1   世界圣经（02 产出）
 ├─ EpisodeMap         1:1   分集总表（02 产出）
 ├─ ProjectAsset       N:M   ←→ Asset  项目按引用关联全局资产（关联表）
 └─ Episode            1:N   分集
     ├─ EpisodeScript  1:1   单集剧本（03 产出）
     ├─ Storyboard     1:1   分集分镜 JSON（06 产出）
     │   └─ Segment    1:N   镜头碎片（每段 ≤15s）★最小单元
     │       ├─ StoryboardPanel  1:1  草稿分镜板（07 产出）
     │       └─ Clip            1:1  视频段（08 产出）
     └─ CanvasGraph    1:1   EP 工坊画布（自由编排 DAG，ADR-001）
         ├─ CanvasNode  1:N
         └─ CanvasEdge  1:N  （有序连线）

GenerationJob          独立表，异步任务状态（ADR-003），可挂在任意可生成实体上
```

**资产全局化**（ADR-005）：`Asset` 是顶层实体，不挂在 `Project` 下。项目通过 `ProjectAsset` 关联表多对多引用资产——同一资产可被多个项目共享，删除项目不删资产。`Asset.source_project_id` 可空，用于追溯它最初由哪个项目的 02 CharacterBible/WorldBible 生成；02→04/05 的出图产物发布到全局库并填此字段，而非写入项目私有列表。画布节点的资产节点其 `ref_id` 指向全局 `Asset.id`。

**基数铁律**（来自 [06 §0.2](../test/instructions/06_分集分镜.md)）：`Episode 1:N Segment`，且 `count(Segment) ≥ ceil(total_duration_sec / 15)`。这条约束在 pydantic 用 validator 强制，在 service 层生成分镜时校验。

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
    duration_sec: int = Field(le=15, gt=0)   # §0.1 硬约束：≤15s
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
    total_duration_sec: int
    temporary_assets: list[TemporaryAsset] = []
    segments: list[Segment]

    @model_validator(mode="after")
    def _check_invariants(self) -> "StoryboardJSON":
        # §0.2 防塌缩：段数下限
        import math
        floor = math.ceil(self.total_duration_sec / 15)
        if len(self.segments) < floor:
            raise ValueError(
                f"segment 数量 {len(self.segments)} < 下限 {floor} "
                f"(ceil({self.total_duration_sec}/15))，疑似段数塌缩"
            )
        # §0.3 总时长闭合
        total = sum(s.duration_sec for s in self.segments)
        if total != self.total_duration_sec:
            raise ValueError(
                f"Σ duration_sec={total} != total_duration_sec={self.total_duration_sec}"
            )
        return self
```

> 这个 `_check_invariants` 是把 pipeline 最容易出错的两条铁律（段数塌缩、总时长闭合）从"心里走一遍的自检清单"升级成"代码层强制校验"。06 agent 的输出一进系统就过这道闸，不合格立即失败、就近上游修复。

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

class CanvasNode(BaseModel):
    """对应 Node 继承体系的扁平 DTO（kind 区分子类型）。

    基类语义：每个节点都有 id / name / position / data。``ref_id`` 让
    ImageNode 引用全局 Asset（人物/道具/场景语义由 Asset.kind 承载），或让
    内容型 TextNode 绑定某个 Segment。
    """
    id: str
    kind: NodeKind
    name: str = ""
    ref_id: int | None = None      # ImageNode→Asset.id / TextNode→Segment.id
    position: tuple[float, float] = (0.0, 0.0)
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
2. 按 `CanvasEdge.order` 升序排列入边，得到**有序输入**——这正对应 08 阶段的参考图固定顺序（`@图1人物 @图2分镜资产 @图3场景 @图4道具`，见 [08](../test/instructions/08_视频生成执行.md)）。顺序首先作用在 adapter 的最终多模态 `content` 上，同时 `IMAGE` 输入也会投影成参考图列表。
3. 按输入类型分流并保留混合顺序：`TEXT` 输入提供 prompt/content text；`IMAGE` 输入提供参考图 content（来自 `ImageNode` 引用的 `Asset.image_path` 或上游 ImageGen 产物）。各图引用的 `Asset.kind` 承载人物/场景/道具语义。
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
    title: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(default=func.now())
    # 1:1 阶段产出以 JSON 列内联（前期），或拆独立表（后期）
    story_digest: Mapped[dict | None] = mapped_column(JSON, default=None)
    character_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    world_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    episode_map: Mapped[dict | None] = mapped_column(JSON, default=None)
    # 资产是全局的（ADR-005）：项目通过 ProjectAsset 关联表引用，多对多
    assets: Mapped[list["Asset"]] = relationship(
        secondary="project_asset", back_populates="projects"
    )
    episodes: Mapped[list["Episode"]] = relationship(back_populates="project")

class Asset(Base):
    """全局视觉资产（ADR-005）。不隶属任何项目，可被多个项目引用。"""
    __tablename__ = "asset"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str]                       # AssetKind
    name: Mapped[str]
    spec: Mapped[dict] = mapped_column(JSON)        # 视觉锚点 / 设计参数
    image_path: Mapped[str | None] = None           # 生成的参考图（04/05 产出）
    # 可追源：最初由哪个项目的 02 Bible 生成；可空（手动创建的全局资产无来源）
    source_project_id: Mapped[int | None] = mapped_column(
        ForeignKey("project.id"), default=None
    )
    created_at: Mapped[datetime] = mapped_column(default=func.now())
    projects: Mapped[list["Project"]] = relationship(
        secondary="project_asset", back_populates="assets"
    )

class ProjectAsset(Base):
    """项目↔资产 多对多关联表（ADR-005）。"""
    __tablename__ = "project_asset"
    project_id: Mapped[int] = mapped_column(ForeignKey("project.id"), primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("asset.id"), primary_key=True)

class Episode(Base):
    __tablename__ = "episode"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("project.id"))
    episode_no: Mapped[int]                 # EP01 的 01
    title: Mapped[str]
    total_duration_sec: Mapped[int]
    script: Mapped[dict | None] = mapped_column(JSON, default=None)       # EpisodeScript
    storyboard: Mapped[dict | None] = mapped_column(JSON, default=None)   # StoryboardJSON
    canvas: Mapped[dict | None] = mapped_column(JSON, default=None)       # CanvasGraph
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

> `GenerationJob.provider_task_id` 直接对应 [videogen.py](../test/videogen.py) 的 `poll` 命令思路：本地轮询被打断时，任务在渠道侧继续跑，凭这个 id 恢复。这是 ADR-003"重启可恢复"的字段支撑。

### 3.1 JSON 列 vs 拆表的取舍

前期把 1:1 的阶段产出（StoryDigest / Bible / StoryboardJSON / CanvasGraph）以 JSON 列内联，理由：

- 这些是**整体读写**的文档，很少做字段级查询；JSON 列避免十几张关联表的连接开销与迁移负担。
- pydantic 模型已经是这些 JSON 的 schema 与校验器，ORM 不必重复建模。
- `Segment` 单独拆 `segment` 表，因为它要被画布节点 `ref_id` 引用、要挂 `panel_path`/`clip_path`、要单独跑生成任务——有独立的关系与生命周期，值得成表。

后期若出现字段级查询需求（如"查所有用了某道具的 segment"），再用 Alembic 迁移拆表。ORM 选型的全部意义就是让这种迁移成本可控。

## 4. 校验责任分层

| 校验 | 落点 | 例 |
|---|---|---|
| 字段类型 / 枚举 | pydantic 字段 | `duration_sec: int = Field(le=15)` |
| 单实体不变量 | pydantic `model_validator` | 段数下限、总时长闭合、DAG 无环 |
| 跨实体一致性 | service 层 | 资产引用存在、segment 引用的 asset 属于同 project |
| 持久化约束 | ORM / DB | 外键、唯一约束 |

原则：能在 pydantic 层锁的就不下沉到 service，能在 schema 锁的就不靠约定——与用户"把不变量集中在数据模型本身"的偏好一致。
