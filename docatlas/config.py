"""Runtime configuration for DocAtlas.

Reads `.env` (via python-dotenv if available — optional dependency at
runtime) and exposes a single `HarnessConfig` dataclass.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _maybe_load_dotenv() -> None:
    explicit = os.getenv("HARNESS_ENV_FILE")
    candidates = [Path(explicit).expanduser()] if explicit else []
    candidates.append(Path(__file__).resolve().parent.parent / ".env")
    found = next((c for c in candidates if c.is_file()), None)
    if explicit and found is None:
        raise FileNotFoundError(f"HARNESS_ENV_FILE does not exist: {explicit}")
    try:
        from dotenv import load_dotenv  # type: ignore
    except ImportError:
        if found is not None:
            # Silent skip used to cost us a debug round when the harness was
            # launched under a Python without python-dotenv but with .env on
            # disk — emit a hint instead.
            import sys

            print(
                f"warning: found {found} but python-dotenv is not installed in "
                f"this interpreter; .env values will NOT be loaded. "
                f"Source it manually (`set -a; source .env; set +a`) or use a "
                f"venv with python-dotenv installed.",
                file=sys.stderr,
            )
        return
    if found is not None:
        load_dotenv(found, override=False)


@dataclass
class HarnessConfig:
    azure_endpoint: str = ""
    azure_api_version: str = ""
    azure_deployment: str = ""  # used as the `model` name in Responses calls
    skill_python: str | None = None
    reasoning_effort: str = "high"
    reasoning_summary: str = "auto"
    image_detail: str = "auto"
    max_turns: int = 20
    parallel_tool_calls: bool = False
    llm_timeout_seconds: float = 120.0
    # Auxiliary LLM — used by SKILLs like Review that need their own client.
    # Default: same as main. Override via HARNESS_AUX_LLM_* env vars.
    aux_endpoint: str = ""
    aux_api_version: str = ""
    aux_model: str = ""
    # Memory policy — archive stale Read outputs post-Note.
    enable_memory: bool = False
    # Tree annotation — auto-annotate tree after each Note call.
    enable_tree_annotate: bool = False

    @classmethod
    def from_env(cls) -> HarnessConfig:
        _maybe_load_dotenv()
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "")
        # Fall back to AZURE_API_VERSION if the canonical name isn't set.
        api_version = (
            os.getenv("AZURE_OPENAI_API_VERSION")
            or os.getenv("AZURE_API_VERSION")
            or "2025-04-01-preview"
        )
        deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "")
        if not endpoint:
            raise RuntimeError(
                "AZURE_OPENAI_ENDPOINT is not set. Copy .env.example to .env and fill it in."
            )
        if not deployment:
            raise RuntimeError(
                "AZURE_OPENAI_DEPLOYMENT is not set. Copy .env.example to .env and set it "
                "to your Azure deployment (model) name."
            )
        aux_endpoint = os.getenv("HARNESS_AUX_LLM_ENDPOINT") or endpoint
        aux_api_version = os.getenv("HARNESS_AUX_LLM_API_VERSION") or api_version
        aux_model = os.getenv("HARNESS_AUX_LLM_MODEL") or deployment
        enable_memory = (os.getenv("HARNESS_ENABLE_MEMORY", "") or "").lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        enable_tree_annotate = (os.getenv("HARNESS_ENABLE_TREE_ANNOTATE", "") or "").lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        try:
            llm_timeout_seconds = max(1.0, float(os.getenv("HARNESS_LLM_TIMEOUT_SECONDS", "120")))
        except ValueError:
            llm_timeout_seconds = 120.0

        return cls(
            azure_endpoint=endpoint,
            azure_api_version=api_version,
            azure_deployment=deployment,
            skill_python=os.getenv("HARNESS_SKILL_PYTHON"),
            aux_endpoint=aux_endpoint,
            aux_api_version=aux_api_version,
            aux_model=aux_model,
            enable_memory=enable_memory,
            enable_tree_annotate=enable_tree_annotate,
            llm_timeout_seconds=llm_timeout_seconds,
        )
