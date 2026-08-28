"""Shared construction of a DocAtlas session, dispatcher, and AgentLoop."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .agent.dispatch import SkillDispatcher
from .agent.loop import AgentLoop
from .agent.post_note import PostNoteHooks
from .config import HarnessConfig
from .llm.factory import make_backend
from .prompt_composer import build_tool_schemas, compose_system_prompt
from .session import DocEnv, SessionStore
from .skill_loader import LoadedSkill
from .ui.callbacks import LoopCallbacks


@dataclass
class AgentRuntime:
    """The stateful components required for one document conversation."""

    session: SessionStore
    loop: AgentLoop
    skills: list[LoadedSkill]


def create_agent_runtime(
    *,
    doc_env: DocEnv,
    question: str,
    skills: list[LoadedSkill],
    config: HarnessConfig,
    figure_min_size: int = 100,
    figure_min_bytes: int = 2048,
    max_input_images: int = 50,
    callbacks: LoopCallbacks | None = None,
    sessions_root: Path | None = None,
) -> AgentRuntime:
    """Create a session and wire all core agent components consistently."""
    if min(figure_min_size, figure_min_bytes, max_input_images) < 0:
        raise ValueError("figure and input-image limits must be non-negative")

    session = SessionStore.new(doc_env, question=question, sessions_root=sessions_root)
    aux_env: dict[str, str] = {}
    if config.aux_endpoint:
        aux_env["HARNESS_AUX_LLM_ENDPOINT"] = config.aux_endpoint
    if config.aux_api_version:
        aux_env["HARNESS_AUX_LLM_API_VERSION"] = config.aux_api_version
    if config.aux_model:
        aux_env["HARNESS_AUX_LLM_MODEL"] = config.aux_model
    aux_env["HARNESS_ENABLE_MEMORY"] = "1" if config.enable_memory else "0"
    aux_env["HARNESS_ENABLE_TREE_ANNOTATE"] = "1" if config.enable_tree_annotate else "0"
    aux_env["HARNESS_FIGURE_MIN_SIZE"] = str(figure_min_size)
    aux_env["HARNESS_FIGURE_MIN_BYTES"] = str(figure_min_bytes)

    dispatcher = SkillDispatcher(
        skills,
        session_args={
            "pdf": doc_env.pdf_path,
            "markdown_dir": doc_env.markdown_dir,
            "doc_id": doc_env.doc_id,
            "doc_map": doc_env.doc_map,
        },
        python_executable=config.skill_python,
        session_file=session.path,
        extra_env=aux_env,
    )
    loop = AgentLoop(
        backend=make_backend(config),
        dispatcher=dispatcher,
        tool_schemas=build_tool_schemas(skills),
        system_prompt=compose_system_prompt(
            skills,
            memory_enabled=config.enable_memory,
            tree_annotate_enabled=config.enable_tree_annotate,
        ),
        max_turns=config.max_turns,
        image_detail=config.image_detail,
        post_note_hooks=(
            PostNoteHooks(
                archive_enabled=config.enable_memory,
                tree_annotate_enabled=config.enable_tree_annotate,
            )
            if (config.enable_memory or config.enable_tree_annotate)
            else None
        ),
        session_store=session,
        callbacks=callbacks,
        max_input_images=max_input_images,
    )
    return AgentRuntime(session=session, loop=loop, skills=skills)


__all__ = ["AgentRuntime", "create_agent_runtime"]
