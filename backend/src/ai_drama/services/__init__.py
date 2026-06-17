"""Service layer (docs/03 §1). Re-exports CRUD + canvas compiler + job services."""

from __future__ import annotations

from ai_drama.services.canvas_compiler import (
    CompileError,
    compile_image_request,
    compile_text_request,
    compile_video_request,
)
from ai_drama.services.crud import (
    create_asset,
    create_episode,
    create_project,
    get_asset,
    get_canvas,
    get_episode,
    get_project,
    get_segment,
    link_project_asset,
    list_assets,
    list_episodes,
    list_project_assets,
    list_projects,
    list_segments,
    save_canvas,
    set_storyboard,
    unlink_project_asset,
)
from ai_drama.services.jobs import (
    create_video_job,
    generate_image_job,
    generate_text_job,
    get_job,
    resume_running_jobs,
    run_video_job,
)

__all__ = [
    "CompileError",
    "compile_image_request",
    "compile_text_request",
    "compile_video_request",
    "create_asset",
    "create_episode",
    "create_project",
    "create_video_job",
    "generate_image_job",
    "generate_text_job",
    "get_asset",
    "get_canvas",
    "get_episode",
    "get_job",
    "get_project",
    "get_segment",
    "link_project_asset",
    "list_assets",
    "list_episodes",
    "list_project_assets",
    "list_projects",
    "list_segments",
    "resume_running_jobs",
    "run_video_job",
    "save_canvas",
    "set_storyboard",
    "unlink_project_asset",
]
