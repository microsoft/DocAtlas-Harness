"""PostNoteHooks — loop-level hooks that fire after a Note call.

Two hooks:
1. **Archive**: replace stale tool outputs with short placeholders
   (adapted for Responses-API item shapes).
2. **Tree annotation**: lift the latest note's findings into the PageIndex tree.

Trigger model: hooks fire when the *just-finished* turn included a call to
one of the `trigger_skills` (default: `Note`).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

ARCHIVE_TAG = "(archived)"
logger = logging.getLogger(__name__)


@dataclass
class ArchiveResult:
    modified: bool
    items: list[dict]  # the (possibly new) mirror list
    archived_count: int
    reason: str = ""


def _format_placeholder(skill_name: str, args: dict) -> str:
    """Build the short text that replaces an archived tool output."""
    page_refs: list[int] = []
    pages_arg = args.get("pages")
    # Read accepts strings like "1,3-5" or lists of ints.
    if isinstance(pages_arg, str):
        for chunk in pages_arg.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            if "-" in chunk:
                a, _, b = chunk.partition("-")
                try:
                    lo, hi = int(a), int(b)
                    page_refs.extend(range(lo, hi + 1))
                except ValueError:
                    continue
            else:
                try:
                    page_refs.append(int(chunk))
                except ValueError:
                    continue
    elif isinstance(pages_arg, list):
        for x in pages_arg:
            try:
                page_refs.append(int(x))
            except (TypeError, ValueError):
                continue

    if page_refs:
        pages_str = f"Pages {min(page_refs)}-{max(page_refs)}"
    else:
        pages_str = "Pages (unknown range)"
    return (
        f"[{skill_name}: {pages_str} were read earlier and have been archived. "
        f"The evidence is captured in your progress notes — call Review to "
        f"recall it, or re-invoke {skill_name} if you need to re-read specific "
        f"pages.] {ARCHIVE_TAG}"
    )


def _item_has_input_image(item: dict) -> bool:
    if not isinstance(item, dict):
        return False
    if item.get("role") != "user":
        return False
    content = item.get("content")
    if not isinstance(content, list):
        return False
    for part in content:
        if isinstance(part, dict) and part.get("type") == "input_image":
            return True
    return False


def _rewrite_items(
    all_items: list[dict],
    *,
    skills_to_archive: set[str],
    archive_tag: str = ARCHIVE_TAG,
) -> tuple[list[dict], int]:
    """Return (new_items, archived_count) after replacing eligible outputs.

    Pairs each `function_call` item with the next `function_call_output`
    sharing its `call_id`. Outputs that already contain `archive_tag` are
    left alone so re-invoking is idempotent.

    Drops any `input_image` user-message that immediately follows an
    archived output (orphaned evidence).
    """
    # Build call_id -> (skill_name, args_str) from function_call items.
    call_name_by_id: dict[str, tuple[str, str]] = {}
    for item in all_items:
        if isinstance(item, dict) and item.get("type") == "function_call":
            cid = str(item.get("call_id") or item.get("id") or "")
            if cid:
                call_name_by_id[cid] = (
                    str(item.get("name", "") or ""),
                    str(item.get("arguments", "") or ""),
                )

    archived_count = 0
    out: list[dict] = []
    i = 0
    n = len(all_items)
    while i < n:
        item = all_items[i]
        if isinstance(item, dict) and item.get("type") == "function_call_output":
            cid = str(item.get("call_id") or "")
            skill_name, args_str = call_name_by_id.get(cid, ("", ""))
            current_output = str(item.get("output", "") or "")
            if skill_name in skills_to_archive and archive_tag not in current_output:
                # Parse args for page refs (best effort).
                import json as _json

                try:
                    args_dict = _json.loads(args_str) if args_str else {}
                except Exception:  # noqa: BLE001
                    args_dict = {}
                placeholder = _format_placeholder(skill_name, args_dict)
                new_item = dict(item)
                new_item["output"] = placeholder
                out.append(new_item)
                archived_count += 1
                # Drop an immediately-following input_image user message.
                if i + 1 < n and _item_has_input_image(all_items[i + 1]):
                    i += 2
                    continue
                i += 1
                continue
        out.append(item)
        i += 1

    return out, archived_count


class PostNoteHooks:
    """Archive Read outputs and annotate tree after a Note call.

    A unified hook that runs both archive and tree-annotate logic.
    """

    def __init__(
        self,
        skills_to_archive: set[str] | None = None,
        trigger_skills: set[str] | None = None,
        archive_tag: str = ARCHIVE_TAG,
        archive_enabled: bool = True,
        tree_annotate_enabled: bool = True,
    ):
        self.skills_to_archive = set(skills_to_archive or {"read"})
        self.trigger_skills = set(trigger_skills or {"note"})
        self.archive_tag = archive_tag
        self.archive_enabled = archive_enabled
        self.tree_annotate_enabled = tree_annotate_enabled

    def _annotate_tree_from_latest_note(self, session_store) -> None:
        entries = session_store.notes.analysis_entries()
        if not entries:
            return
        latest = entries[-1]
        from ..session.tree import annotate_tree_from_note

        result = annotate_tree_from_note(
            session_store.tree,
            note_data=latest.data,
            question=session_store.notes.question,
            return_details=True,
        )
        if isinstance(result, dict) and result.get("finding_count", 0) > 0:
            session_store.save()

    def maybe_process(
        self,
        all_items: list[dict],
        last_turn_skill_calls: list[tuple[str, dict]],
        session_store=None,
    ) -> ArchiveResult | None:
        triggered = any(name in self.trigger_skills for name, _ in last_turn_skill_calls)
        if not triggered:
            return None

        # Constructor flags are policy ceilings set by the operator. A model
        # may opt out of enabled effects, but it may never turn on an effect
        # that the operator disabled.
        do_archive = self.archive_enabled
        do_enrich = self.tree_annotate_enabled

        # Per-note override via side_effect_policy on the latest Note.
        try:
            if session_store is not None:
                entries = session_store.notes.analysis_entries()
                if entries:
                    policy = str(entries[-1].data.get("side_effect_policy", "auto") or "auto")
                    if policy == "save_note_only":
                        do_archive = False
                        do_enrich = False
                    elif policy == "save_and_archive":
                        do_archive = self.archive_enabled
                        do_enrich = False
                    elif policy == "save_and_enrich":
                        do_archive = False
                        do_enrich = self.tree_annotate_enabled
                    elif policy == "save_archive_and_enrich":
                        do_archive = self.archive_enabled
                        do_enrich = self.tree_annotate_enabled
                    # 'auto' / unknown → leave defaults
        except Exception:  # noqa: BLE001
            logger.warning("Could not read per-note side-effect policy", exc_info=True)

        if not do_archive and not do_enrich:
            return None

        archive_result = None
        if do_archive:
            new_items, n = _rewrite_items(
                all_items,
                skills_to_archive=self.skills_to_archive,
                archive_tag=self.archive_tag,
            )
            if n == 0:
                archive_result = ArchiveResult(
                    modified=False,
                    items=all_items,
                    archived_count=0,
                    reason="Note triggered but no eligible outputs to archive",
                )
            else:
                archive_result = ArchiveResult(
                    modified=True,
                    items=new_items,
                    archived_count=n,
                    reason=f"archived {n} stale tool output(s) after Note",
                )

        if do_enrich and session_store is not None and getattr(session_store, "tree", None):
            try:
                self._annotate_tree_from_latest_note(session_store)
            except Exception:  # noqa: BLE001
                logger.exception("Could not enrich the session tree from the latest note")

        return archive_result


__all__ = [
    "ARCHIVE_TAG",
    "ArchiveResult",
    "PostNoteHooks",
    "_rewrite_items",
]
