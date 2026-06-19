"""Typer CLI: the human + pytest entrypoint to the backend core.

Command groups mirror pipeline stages (docs/03 §2) so each stage can be driven
and verified independently. Ships the ``project`` group, a ``serve`` command for
the API, and a ``seed-demo`` command that builds a full single-segment slice end
to end (project → asset → episode → storyboard → canvas → rendered clip) so the
whole vertical can be exercised from the command line.
"""

from __future__ import annotations

import asyncio

import typer

from ai_drama.db import SessionLocal, init_db
from ai_drama.models import (
    AssetCreate,
    AssetKind,
    CanvasEdge,
    CanvasGraph,
    CanvasNode,
    EpisodeCreate,
    NodeKind,
    ProjectCreate,
    Segment,
    StoryboardJSON,
)
from ai_drama import services

app = typer.Typer(
    name="ai-drama",
    help="AI short-drama production platform — backend CLI.",
    no_args_is_help=True,
)

project_app = typer.Typer(name="project", help="Manage projects.", no_args_is_help=True)
app.add_typer(project_app)


@project_app.command("create")
def project_create(title: str = typer.Argument(..., help="Project title.")) -> None:
    """Create a new project."""
    init_db()
    with SessionLocal() as db:
        project = services.create_project(db, ProjectCreate(title=title))
        typer.echo(f"Created project #{project.id}: {project.title}")


@project_app.command("list")
def project_list() -> None:
    """List all projects."""
    init_db()
    with SessionLocal() as db:
        projects = services.list_projects(db)
    if not projects:
        typer.echo("No projects yet. Create one with: ai-drama project create <title>")
        return
    for p in projects:
        typer.echo(f"#{p.id}\t{p.title}\t{p.created_at:%Y-%m-%d %H:%M}")


@app.command("seed-demo")
def seed_demo(
    channel: str = typer.Option(
        "mock", help='Video channel: "mock" (offline) or "routin" (live, needs key).'
    ),
) -> None:
    """Build and render a single-segment demo end to end.

    Creates a project, a character + scene asset, an episode with a one-segment
    storyboard, wires a canvas (assets + content → video_output), then submits
    and runs the video job synchronously. Prints the resulting clip path.
    """
    init_db()
    with SessionLocal() as db:
        project = services.create_project(db, ProjectCreate(title="Demo · 单段出片"))
        char = services.create_project_asset(
            db,
            project.id,
            AssetCreate(
                kind=AssetKind.CHARACTER,
                name="女主",
            ),
        )
        scene = services.create_project_asset(
            db,
            project.id,
            AssetCreate(
                kind=AssetKind.SCENE,
                name="国公府前院",
            ),
        )
        episode = services.create_episode(
            db,
            project.id,
            EpisodeCreate(episode_no=1, title="EP01"),
        )
        storyboard = StoryboardJSON(
            episode_id=episode.id,
            title="EP01",
            segments=[
                Segment(
                    segment_id=1,
                    duration_sec=6,
                    visual_prompt=(
                        "极慢推进，中景到近景；女主立于国公府前院大门内侧，"
                        "背对大门面朝内堂，指尖捏紧衣角，瞳孔骤缩——画面无字幕。"
                    ),
                )
            ],
        )
        services.set_storyboard(db, episode.id, storyboard)
        segment = services.list_segments(db, episode.id)[0]

        # Generic compute graph: image + image + text → video_gen.
        graph = CanvasGraph(
            episode_id=episode.id,
            nodes=[
                CanvasNode(
                    id="img-c", kind=NodeKind.IMAGE, name="女主", ref_id=char.id
                ),
                CanvasNode(
                    id="img-s", kind=NodeKind.IMAGE, name="前院", ref_id=scene.id
                ),
                CanvasNode(
                    id="txt",
                    kind=NodeKind.TEXT,
                    name="镜头提示",
                    ref_id=segment.id,
                    data={"visual_prompt": storyboard.segments[0].visual_prompt},
                ),
                CanvasNode(id="vgen", kind=NodeKind.VIDEO_GEN, name="视频生成"),
            ],
            edges=[
                CanvasEdge(id="e1", source="img-c", target="vgen", order=1),
                CanvasEdge(id="e2", source="txt", target="vgen", order=2),
                CanvasEdge(id="e3", source="img-s", target="vgen", order=3),
            ],
        )
        services.save_canvas(db, episode.id, graph)

        def image_for_asset(ref_id):
            asset = services.get_project_asset(db, project.id, ref_id)
            return asset.image_path if asset else None

        request = services.compile_video_request(
            graph,
            output_node_id="vgen",
            resolve_asset_image=image_for_asset,
        )
        job = services.create_video_job(
            db,
            target_table="segment",
            target_id=segment.id,
            output_node_id="vg",
            request=request,
            channel=channel,
        )
        typer.echo(f"Submitted job {job.id} (channel={channel}) ...")

    asyncio.run(services.run_video_job(job.id, interval=0.5))

    with SessionLocal() as db:
        done = services.get_job(db, job.id)
        typer.echo(f"Job status: {done.status}")
        if done.result:
            typer.echo(f"Clip: {done.result.get('clip_path')}")
        if done.error:
            typer.echo(f"Error: {done.error}", err=True)


@app.command("serve")
def serve(
    host: str = typer.Option("127.0.0.1", help="Bind host."),
    port: int = typer.Option(8770, help="Bind port."),
    reload: bool = typer.Option(False, "--reload", help="Enable autoreload (dev)."),
) -> None:
    """Run the FastAPI server (uvicorn)."""
    import uvicorn

    uvicorn.run("ai_drama.api:app", host=host, port=port, reload=reload)


def main() -> None:
    """Console-script entrypoint (referenced by pyproject [project.scripts])."""
    app()


if __name__ == "__main__":
    main()
