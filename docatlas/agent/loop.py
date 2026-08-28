"""Multi-turn agent loop driving an LLMBackend over a SkillDispatcher.

Loop shape:

  1. Send (system prompt + user message).
  2. For each response:
     - If the model produced function_calls: dispatch each via the
       SkillDispatcher, send tool outputs back as `function_call_output`
       items, AND if any image URIs came along, append a follow-up
       `user` message containing `input_image` blocks. Chain via
       `previous_response_id`.
     - If the model produced no function_calls: that's the final answer.
  3. On the last allowed turn, force `tool_choice="none"` so the model
      produces an answer instead of looping forever.

Memory policy (optional): at the end of each turn the loop asks the
policy whether any prior tool outputs should be archived in-place. When
archival fires we break the server chain once — resend the full
(archived) local mirror next turn with `previous_response_id=None` —
then resume chaining on the new response id.

The image-injection step is the §6.1 differentiator: the SKILL still
just emits a JSON document with base64 data URIs, and the harness
quietly upgrades them to native multimodal content blocks for the model.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from ..llm.base import LLMBackend
from ..ui.callbacks import LoopCallbacks
from .dispatch import SkillDispatcher, SkillResult
from .post_note import PostNoteHooks
from .trace import AgentResult, ToolCallEvent, TurnEvent

logger = logging.getLogger(__name__)


@dataclass
class AgentLoop:
    backend: LLMBackend
    dispatcher: SkillDispatcher
    tool_schemas: list[dict]
    system_prompt: str
    max_turns: int = 20
    image_detail: str = "auto"
    post_note_hooks: PostNoteHooks | None = None
    session_store: Any | None = None
    callbacks: LoopCallbacks | None = None
    max_input_images: int = 50

    def _cb(self, name: str, *args) -> None:
        """Fire a callback hook if callbacks are registered."""
        if self.callbacks is not None:
            getattr(self.callbacks, name)(*args)

    @staticmethod
    def _trim_input_images(items: list[dict], *, max_images: int) -> tuple[list[dict], int]:
        """FIFO trim: drop oldest ``input_image`` parts so total ≤ *max_images*.

        Returns ``(trimmed_items, removed_count)``.
        """
        # Count total images first
        total = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, list):
                total += sum(
                    1 for p in content if isinstance(p, dict) and p.get("type") == "input_image"
                )
        if total <= max_images:
            return items, 0

        to_remove = total - max_images
        removed = 0
        out: list[dict] = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("content"), list):
                out.append(item)
                continue
            new_content = []
            for part in item["content"]:
                if (
                    isinstance(part, dict)
                    and part.get("type") == "input_image"
                    and removed < to_remove
                ):
                    removed += 1
                    continue
                new_content.append(part)
            if new_content:
                out.append({**item, "content": new_content})
            # else: drop the item entirely (was image-only user message)
        return out, removed

    def _snapshot_recent_messages(self, all_items: list[dict]) -> None:
        """Persist the last 4 user/assistant text turns into session.workspace.recent_messages.

        Used by subprocess SKILLs (Search) that lack direct access to the
        conversation.
        """
        if self.session_store is None:
            return
        recent: list[dict] = []
        for item in all_items[-20:]:  # scan a wider window, then take last 4 textual
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            if role not in ("user", "assistant"):
                continue
            content = item.get("content")
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                parts: list[str] = []
                for p in content:
                    if isinstance(p, dict):
                        t = p.get("text") or p.get("input_text") or ""
                        if t:
                            parts.append(str(t))
                text = " ".join(parts)
            text = text.strip()
            if not text:
                continue
            recent.append({"role": role, "text": text[:300]})
        recent = recent[-4:]
        self.session_store.workspace["recent_messages"] = recent
        try:
            self.session_store.save()
        except Exception:  # noqa: BLE001
            logger.warning("Could not persist recent message metadata", exc_info=True)

    def _make_image_followup(self, results: list[SkillResult]) -> list[dict]:
        """If any tool result carried images, build a single user message
        whose content lists them as input_image blocks. Return [] if none."""
        parts: list[dict] = []
        for r in results:
            if not r.image_uris:
                continue
            for index, uri in enumerate(r.image_uris):
                label = (
                    r.image_labels[index]
                    if index < len(r.image_labels)
                    else f"Image {index + 1} returned by {r.skill_name}"
                )
                parts.append(
                    {
                        "type": "input_text",
                        "text": f"[{label}]",
                    }
                )
                parts.append(
                    {
                        "type": "input_image",
                        "image_url": uri,
                        "detail": self.image_detail,
                    }
                )
        if not parts:
            return []
        return [{"role": "user", "content": parts}]

    def run(self, user_message: str) -> AgentResult:
        result = AgentResult()
        t_start = time.time()

        # Local mirror of every item the server has ever seen in this run.
        # Seeded with developer + user. Appended-to as the turns progress.
        all_items: list[dict] = [
            {"role": "developer", "content": self.system_prompt},
            {"role": "user", "content": user_message},
        ]
        # What we send on the NEXT API call. On the first call it's the full
        # seed; on subsequent chained calls it's just the new items.
        input_items: list[dict] = list(all_items)
        previous_response_id: str | None = None
        rechain_pending: bool = False  # set after archival; next call resends mirror

        for turn_num in range(1, self.max_turns + 1):
            turn = TurnEvent(turn_num=turn_num)
            t0 = time.time()
            self._cb("on_turn_start", turn_num)
            force_no_tools = turn_num == self.max_turns

            if rechain_pending:
                # Archival happened → resend full mirror, no previous_response_id.
                input_items = list(all_items)
                previous_response_id = None
                rechain_pending = False

            # FIFO trim: drop oldest images if we exceed the per-request cap.
            # Applied to the full mirror (which is what we send after archival
            # or on a rechain) or just to input_items on a chained turn.
            if self.max_input_images > 0:
                input_items, n_trimmed = self._trim_input_images(
                    input_items,
                    max_images=self.max_input_images,
                )
                if n_trimmed:
                    logger.info(
                        "[image-trim] turn %s: dropped %s oldest image(s) (cap=%s)",
                        turn_num,
                        n_trimmed,
                        self.max_input_images,
                    )
                    # Also trim the full mirror so it stays in sync
                    all_items, _ = self._trim_input_images(
                        all_items,
                        max_images=self.max_input_images,
                    )

            try:
                response = self.backend.create_response(
                    input_items=input_items,
                    tools=self.tool_schemas,
                    previous_response_id=previous_response_id,
                    force_no_tools=force_no_tools,
                )
            except Exception as e:  # noqa: BLE001
                turn.elapsed_s = time.time() - t0
                result.error = f"backend error on turn {turn_num}: {e}"
                result.turns.append(turn)
                logger.exception("LLM backend failed on turn %s", turn_num)
                break

            turn.elapsed_s = time.time() - t0
            turn.input_tokens = response.input_tokens
            turn.output_tokens = response.output_tokens
            turn.reasoning_tokens = response.reasoning_tokens
            turn.reasoning_summary = response.reasoning_summary
            if response.reasoning_summary:
                self._cb("on_reasoning", response.reasoning_summary)
            turn.text_output = response.text
            result.total_input_tokens += response.input_tokens
            result.total_output_tokens += response.output_tokens
            result.total_reasoning_tokens += response.reasoning_tokens

            # Mirror assistant output: record function_call items (shape the
            # server expects on a resend) and — if this is the final answer —
            # the plain text message.
            for fc in response.function_calls:
                all_items.append(
                    {
                        "type": "function_call",
                        "call_id": fc.call_id,
                        "name": fc.name,
                        "arguments": fc.arguments_json or "",
                    }
                )

            if not response.function_calls:
                # Final answer. Mirror the message too for completeness.
                if response.text:
                    all_items.append(
                        {
                            "role": "assistant",
                            "content": response.text,
                        }
                    )
                result.answer = response.text
                if result.answer:
                    self._cb("on_answer", result.answer)
                result.turns.append(turn)
                self._cb("on_turn_end", turn)
                break

            # Dispatch each tool call.
            tool_result_items: list[dict] = []
            skill_results: list[SkillResult] = []
            skill_calls_this_turn: list[tuple[str, dict]] = []
            for fc in response.function_calls:
                try:
                    args = json.loads(fc.arguments_json) if fc.arguments_json else {}
                except json.JSONDecodeError:
                    args = {"_raw": fc.arguments_json}
                if not isinstance(args, dict):
                    args = {"_raw": fc.arguments_json}

                self._cb("on_tool_call", fc.call_id, fc.name, args)
                tc_t0 = time.time()
                # Snapshot last-4 message-like items into session.workspace.recent_messages
                # so Search (and other subprocess SKILLs) can use conversation context.
                if fc.name == "search" and self.session_store is not None:
                    try:
                        self._snapshot_recent_messages(all_items)
                    except Exception:  # noqa: BLE001
                        logger.warning("Could not snapshot recent messages", exc_info=True)
                skill_result = self.dispatcher.call(fc.name, args)
                tc_elapsed = time.time() - tc_t0
                skill_results.append(skill_result)
                skill_calls_this_turn.append((fc.name, args))
                turn.tool_calls.append(
                    ToolCallEvent(
                        call_id=fc.call_id,
                        name=fc.name,
                        arguments=args,
                        text_output=skill_result.text_output[:2000],
                        image_count=len(skill_result.image_uris),
                        ok=skill_result.ok,
                    )
                )
                self._cb(
                    "on_tool_result",
                    fc.call_id,
                    fc.name,
                    skill_result.text_output[:2000],
                    tc_elapsed,
                    len(skill_result.image_uris),
                )
                tool_result_items.append(
                    {
                        "type": "function_call_output",
                        "call_id": fc.call_id,
                        "output": skill_result.text_output,
                    }
                )

            image_followup = self._make_image_followup(skill_results)
            tool_result_items.extend(image_followup)

            # Append to local mirror.
            all_items.extend(tool_result_items)

            # Server-side chains retain prior images. Once the full mirror
            # exceeds the cap, trim it and deliberately re-chain so the next
            # request cannot retain images that are no longer in local state.
            if self.max_input_images > 0:
                trimmed_items, removed_images = self._trim_input_images(
                    all_items, max_images=self.max_input_images
                )
                if removed_images:
                    all_items = trimmed_items
                    rechain_pending = True
                    logger.info(
                        "[image-trim] turn %s: dropped %s old image(s) and rebuilt the chain",
                        turn_num,
                        removed_images,
                    )

            # End-of-turn post-note hooks.
            if self.post_note_hooks is not None:
                # The Note skill runs as a subprocess and persists to
                # session.json; refresh our in-memory mirror so the hook
                # sees the just-written note. Without this, the hook reads a
                # stale (empty) NoteStore and tree-annotation / per-note
                # side_effect_policy never fire.
                if self.session_store is not None and any(
                    name in self.post_note_hooks.trigger_skills for name, _ in skill_calls_this_turn
                ):
                    try:
                        self.session_store.refresh_from_disk()
                    except Exception:  # noqa: BLE001
                        logger.warning("Could not refresh session after note", exc_info=True)
                archive = self.post_note_hooks.maybe_process(
                    all_items, skill_calls_this_turn, self.session_store
                )
                if archive is not None and archive.modified:
                    all_items = list(archive.items)
                    turn.archived_count = archive.archived_count
                    rechain_pending = True
                    logger.info(
                        "[post_note] turn %s: %s",
                        turn_num,
                        archive.reason,
                    )

            # Default (non-archival) path: chain via previous_response_id,
            # ship only the new items next turn.
            previous_response_id = response.response_id
            input_items = tool_result_items
            result.turns.append(turn)
            self._cb("on_turn_end", turn)
        else:
            # max_turns exhausted without break — note it and keep whatever answer we have
            result.error = f"max_turns ({self.max_turns}) exceeded"
            if not result.answer:
                result.answer = "[max turns exceeded without final answer]"

        result.total_elapsed_s = time.time() - t_start
        return result
