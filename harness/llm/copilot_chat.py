"""Chat-Completions backend (works against any OpenAI-compatible /v1/chat/completions).

Why this exists:
    `AzureResponsesBackend` talks to Azure's Responses API, which keeps the
    multi-turn state on the server (`previous_response_id`) and accepts
    Responses-style input items (`function_call`, `function_call_output`,
    `input_image`, …).

    Many OpenAI-compatible servers (vLLM, LiteLLM, a local proxy, …) expose
    ``/v1/chat/completions`` but **not** ``/v1/responses``. To drive those
    models (Gemini, Claude, GPT-4o, …) through the same `AgentLoop`, we need
    a backend that:

      1. Translates the Responses-style ``input_items`` the loop builds
         into ``messages=[{role, content}]`` for chat.completions.
      2. Translates Responses-style ``tools=[{type:'function', name, …}]``
         into chat-completions ``tools=[{type:'function', function:{name, …}}]``.
      3. Maintains client-side multi-turn state (chat.completions has no
         server-side chaining). We keep a tiny in-memory buffer keyed by
         the synthetic ``response_id`` we hand back to the loop, so the
         loop's existing ``previous_response_id`` plumbing keeps working
         unmodified.
      4. Translates the chat-completions response back into the same
         ``NormalizedResponse`` the loop already consumes — including the
         ``function_calls`` list.

The buffer is per-backend-instance and not thread-safe across instances.
The mmlongbench runner shares one backend across worker threads (matching
how `AzureResponsesBackend` is used), and the buffer is keyed by the
unique synthetic response ids we mint, so concurrent requests don't
collide. We do guard with a lock anyway because dict mutation across
threads can crash CPython under specific patterns.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from typing import Any

import urllib.error
import urllib.request

from .base import FunctionCall, LLMBackend, NormalizedResponse


logger = logging.getLogger(__name__)


# Default reasoning + answer headroom. Gemini 2.5 Pro consumes a *lot* of
# reasoning tokens for tool-using turns; we observed empty completions when
# max_tokens<256. 4096 leaves room for both reasoning + non-trivial answers.
_DEFAULT_MAX_TOKENS = 4096


class CopilotChatBackend(LLMBackend):
    """OpenAI Chat-Completions implementation of ``LLMBackend``.

    Differences from the Responses-API backend the loop was originally
    written for:

    - Responses chains via ``previous_response_id`` (server-side state).
      Chat completions has no such concept, so we keep a per-response_id
      message buffer in memory. The synthetic response_id we return is
      what the loop later hands back as ``previous_response_id``.
    - Responses-style ``input_image`` content parts get rewritten to
      chat-completions ``image_url`` parts.
    - Responses-style ``function_call`` / ``function_call_output`` items
      get rewritten to assistant ``tool_calls`` and role=tool messages.
    - Tool schemas are wrapped in ``{type:'function', function:{...}}``.
    """

    def __init__(
        self,
        *,
        model: str,
        base_url: str = "http://localhost:4141/v1",
        api_key: str = "dummy",
        max_tokens: int = _DEFAULT_MAX_TOKENS,
        temperature: float = 0.0,
        request_timeout: int = 600,
        max_retries: int = 3,
        # Kept for signature parity with AzureResponsesBackend; chat.completions
        # ignores reasoning_effort/summary, but we accept them so the runner
        # doesn't have to special-case which kwargs to pass.
        reasoning_effort: str | None = None,
        reasoning_summary: str | None = None,
        parallel_tool_calls: bool = False,
        # Optional system-prompt override (used by Gemini family, which often
        # benefits from a 1-line "answer concisely" cue under chat.completions).
        extra_system_prefix: str | None = None,
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.request_timeout = request_timeout
        self.max_retries = max_retries
        self.parallel_tool_calls = parallel_tool_calls
        self.extra_system_prefix = extra_system_prefix
        # Unused but kept so the runner can pass them uniformly:
        self._reasoning_effort = reasoning_effort
        self._reasoning_summary = reasoning_summary

        self._buf_lock = threading.Lock()
        self._buffers: dict[str, list[dict]] = {}

    # ── public API ───────────────────────────────────────────────────────

    def create_response(
        self,
        *,
        input_items: list[dict],
        tools: list[dict],
        previous_response_id: str | None,
        force_no_tools: bool = False,
    ) -> NormalizedResponse:
        # 1. Resolve message history.
        if previous_response_id is not None:
            with self._buf_lock:
                prior = list(self._buffers.get(previous_response_id, []))
            if not prior:
                logger.warning(
                    "previous_response_id=%s not found in buffer; falling back to "
                    "treating input_items as the full history. This usually means "
                    "the loop archived a prior turn — which is fine.",
                    previous_response_id,
                )
                messages = self._items_to_messages(input_items)
            else:
                # Append only the new items the loop produced this turn
                # (tool outputs + optional image follow-up).
                new_msgs = self._items_to_messages(input_items)
                messages = prior + new_msgs
        else:
            messages = self._items_to_messages(input_items)

        # 2. Build payload.
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }
        if tools and not force_no_tools:
            payload["tools"] = self._wrap_tools(tools)
            payload["tool_choice"] = "auto"
            if self.parallel_tool_calls:
                payload["parallel_tool_calls"] = True

        # 3. Call.
        data = self._post_with_retry(payload)

        # 4. Translate response.
        normalized, assistant_msg = self._normalize(data)

        # 5. Update buffer for the next chained turn.
        new_buf = list(messages)
        if assistant_msg is not None:
            new_buf.append(assistant_msg)
        synthetic_id = f"copilot-{uuid.uuid4().hex}"
        with self._buf_lock:
            self._buffers[synthetic_id] = new_buf
            # Light cap: drop the previous buffer to bound memory.
            if previous_response_id is not None:
                self._buffers.pop(previous_response_id, None)
        normalized.response_id = synthetic_id
        return normalized

    # ── translation: Responses-style items → chat messages ───────────────

    def _items_to_messages(self, input_items: list[dict]) -> list[dict]:
        """Convert the loop's Responses-style input items into chat messages.

        Item shapes the loop emits (see ``harness/agent/loop.py``):

          {role: developer|user|assistant, content: str | list[content_part]}
          {type: 'function_call', call_id, name, arguments}
          {type: 'function_call_output', call_id, output}

        Content parts (when content is a list):

          {type: 'input_text', text}
          {type: 'input_image', image_url, detail}
          {type: 'text', text}              # rare, treat like input_text
        """
        out: list[dict] = []
        # We need to merge consecutive function_call items into a single
        # assistant message with a tool_calls list. The loop emits one
        # function_call item per call, all from the same model turn.
        pending_tool_calls: list[dict] = []

        def _flush_tool_calls() -> None:
            nonlocal pending_tool_calls
            if pending_tool_calls:
                out.append({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": pending_tool_calls,
                })
                pending_tool_calls = []

        for item in input_items:
            if not isinstance(item, dict):
                continue
            itype = item.get("type")
            if itype == "function_call":
                pending_tool_calls.append({
                    "id": str(item.get("call_id", "")),
                    "type": "function",
                    "function": {
                        "name": item.get("name", ""),
                        "arguments": item.get("arguments", "") or "",
                    },
                })
                continue
            # Anything that isn't a function_call breaks the streak.
            _flush_tool_calls()

            if itype == "function_call_output":
                out.append({
                    "role": "tool",
                    "tool_call_id": str(item.get("call_id", "")),
                    "content": item.get("output", "") or "",
                })
                continue

            role = item.get("role")
            if role is None:
                continue
            if role == "developer":
                # chat.completions has no 'developer' role — fold into 'system'.
                role = "system"

            content = item.get("content")
            if isinstance(content, str):
                if role == "system" and self.extra_system_prefix:
                    content = self.extra_system_prefix + "\n\n" + content
                out.append({"role": role, "content": content})
            elif isinstance(content, list):
                parts = self._content_parts_to_chat(content)
                # If the message ended up text-only, flatten to a string —
                # a few proxies are picky about list content for plain text.
                if all(p.get("type") == "text" for p in parts):
                    text = "".join(p.get("text", "") for p in parts)
                    if role == "system" and self.extra_system_prefix:
                        text = self.extra_system_prefix + "\n\n" + text
                    out.append({"role": role, "content": text})
                else:
                    out.append({"role": role, "content": parts})
            else:
                continue

        _flush_tool_calls()
        return out

    @staticmethod
    def _content_parts_to_chat(parts: list[dict]) -> list[dict]:
        out: list[dict] = []
        for p in parts:
            if not isinstance(p, dict):
                continue
            ptype = p.get("type")
            if ptype in ("input_text", "text"):
                t = p.get("text") or p.get("input_text") or ""
                if t:
                    out.append({"type": "text", "text": t})
            elif ptype == "input_image":
                url = p.get("image_url") or p.get("url")
                if not url:
                    continue
                detail = p.get("detail", "auto")
                out.append({
                    "type": "image_url",
                    "image_url": {"url": url, "detail": detail},
                })
            elif ptype == "image_url":
                # Already in chat shape — pass through.
                out.append(p)
            # other types (audio, file…) are silently dropped for now
        return out

    @staticmethod
    def _wrap_tools(tools: list[dict]) -> list[dict]:
        """Responses tool entries → chat.completions tool entries.

        Responses: ``{type:'function', name, description, parameters}``
        Chat:      ``{type:'function', function:{name, description, parameters}}``
        """
        wrapped: list[dict] = []
        for t in tools:
            if not isinstance(t, dict):
                continue
            if t.get("type") != "function":
                continue
            # Already chat-shaped?
            if "function" in t and isinstance(t["function"], dict):
                wrapped.append(t)
                continue
            wrapped.append({
                "type": "function",
                "function": {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters", {"type": "object", "properties": {}}),
                },
            })
        return wrapped

    # ── HTTP ─────────────────────────────────────────────────────────────

    def _post_with_retry(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}/chat/completions"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                req = urllib.request.Request(url, data=body, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=self.request_timeout) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", errors="replace")
                last_exc = RuntimeError(f"HTTP {e.code}: {err_body[:2000]}")
                # 4xx other than 429 → don't retry, the request itself is bad.
                if 400 <= e.code < 500 and e.code != 429:
                    raise last_exc
            except Exception as e:                    # noqa: BLE001
                last_exc = e

            if attempt < self.max_retries:
                wait_s = 2 ** attempt
                logger.warning(
                    "copilot-api error (attempt %s/%s); retrying in %ss: %s",
                    attempt, self.max_retries, wait_s, last_exc,
                )
                time.sleep(wait_s)

        assert last_exc is not None
        raise last_exc

    # ── translation: chat response → NormalizedResponse ──────────────────

    def _normalize(
        self, data: dict[str, Any]
    ) -> tuple[NormalizedResponse, dict[str, Any] | None]:
        """Return (NormalizedResponse, assistant_msg_for_buffer).

        The assistant message we append to the buffer mirrors what the
        upstream returned, so subsequent turns can reference its
        ``tool_calls`` by id (via role=tool messages).
        """
        choices = data.get("choices") or []
        choice0 = choices[0] if choices else {}
        msg = choice0.get("message") or {}
        text = msg.get("content") or ""
        if isinstance(text, list):
            # Some providers return content as a list of parts even on output.
            text = "".join(
                (p.get("text", "") if isinstance(p, dict) else str(p))
                for p in text
            )

        function_calls: list[FunctionCall] = []
        tool_calls = msg.get("tool_calls") or []
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            function_calls.append(FunctionCall(
                call_id=str(tc.get("id", "")),
                name=fn.get("name", ""),
                arguments_json=fn.get("arguments", "") or "",
            ))

        usage = data.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens", 0) or 0)
        output_tokens = int(usage.get("completion_tokens", 0) or 0)
        # Gemini surfaces reasoning_tokens at the top level of usage; OpenAI
        # surfaces it under completion_tokens_details.reasoning_tokens.
        reasoning_tokens = int(usage.get("reasoning_tokens", 0) or 0)
        ctd = usage.get("completion_tokens_details") or {}
        if not reasoning_tokens and isinstance(ctd, dict):
            reasoning_tokens = int(ctd.get("reasoning_tokens", 0) or 0)

        # Build the assistant message we'll keep in the buffer.
        assistant_for_buffer: dict[str, Any] | None = None
        if function_calls:
            assistant_for_buffer = {
                "role": "assistant",
                "content": text or "",
                "tool_calls": [
                    {
                        "id": fc.call_id,
                        "type": "function",
                        "function": {"name": fc.name, "arguments": fc.arguments_json},
                    }
                    for fc in function_calls
                ],
            }
        elif text:
            assistant_for_buffer = {"role": "assistant", "content": text}

        normalized = NormalizedResponse(
            response_id="",  # filled in by caller
            text=text,
            function_calls=function_calls,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=reasoning_tokens,
            reasoning_summary="",  # chat.completions doesn't surface this
            raw=data,
        )
        return normalized, assistant_for_buffer
