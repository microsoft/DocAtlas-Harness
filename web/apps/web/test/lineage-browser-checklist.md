# Batch24 lineage browser acceptance

Use the actual local host + Pi SDK with the approved scripted-model browser
fixture. These steps test product/SDK behavior, not model quality. Do not enable
paid models or alter production stores merely to run this checklist.

`e2e/live/native-lineage.pw.ts` is the executable application-backed subset:
original-PDF citation → navigation/generation handoff → lost response/GET recovery
→ refresh → fork-at → inherited original citation → explicit new source Read.
A second journey checks first-user parent navigation, empty human history and
fork-before. A third checks binding-pinned Stop: a completed first turn, an
actually held/cancelled provider second turn, exact `If-Match` plus `{}` body,
joined idle execution and a durable cancelled receipt, then a new completed
question without changing the first checkpoint.
They use `startDocAtlasApplication` and real SDK/durable handoffs;
only model wording is scripted. These tests do not imply that every additional
manual/fault scenario below has passed.

Final verification on 2026-09-09 used the frozen server/Web build, one browser
worker and no paid model. The combined lineage/Stop plus existing compaction run
reported **3 passed, 1 failed** (1.9 minutes): only the compaction test's final
mobile geometry check sampled the drawer during its finite reveal animation.
After awaiting that actual animation's `finished` promise, with unchanged
391-pixel bound and no production/style change, the directed compaction rerun
reported **1 passed** (37.9 seconds). The three already-passed journeys were not
repeated. Commands:

```sh
bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/native-lineage.pw.ts e2e/live/native-compaction.pw.ts --output .cache/playwright-lineage-results
bash scripts/pnpmw exec playwright test --config playwright.live.config.ts e2e/live/native-compaction.pw.ts --output .cache/playwright-compaction-final-results
```

Cold application startup is awaited through the exact authenticated snapshot
response before checking the composer; no runtime is prewarmed or fabricated.

1. Create two real turns, including an original-PDF citation, and keep a new
   unsent draft such as `保留的下一问草稿`. Open **运行设置 → 分支／会话树**.
   Only one dialog is open; closing/Escape restores focus. The default tree
   lists user/assistant entries, with parent/depth and current-path markers.
   `data-lineage-entry`, `data-lineage-parent`, `data-lineage-depth` identify
   the actual nodes. Initial reads must not POST a lineage command.
2. Select an assistant node via `选择原生节点 <entryId>`. Enable a branch summary,
   enter whitespace/newline-sensitive instructions, set replace-instructions and
   a label, then click **切换到这个原生位置**. Capture the full POST body before
   sending: approval, old binding/generation, complete file seal, selected leaf,
   context hash, action and key. No private SDK editor text or bounded preview
   becomes the question draft.
3. While accepted/applying/handoff, there is no ready target button. Polling is
   GET-only and stops when closed or terminal. If SSE advances the generation
   before the response, keep the original actor/workspace/source-conversation
   outbox and query the original operation. Only complete durable metadata and
   matching proof/request hash show **刷新到已核验的当前分支**. Click it explicitly;
   verify the target binding/generation and selected history, preserved draft,
   unchanged old Answer publication and original-PDF citation navigation.
4. Fork once **在此用户消息之前创建子会话** and once **从此节点创建子会话**.
   `before` is unavailable for non-user nodes. Confirm distinct child native
   session/conversation and unchanged parent binding. Nothing auto-selects the
   child. **打开已核验的子会话** first verifies its authorized directory binding.
   Returning to the parent restores its original unsent draft. Child drafts are
   their own stored drafts, never a copied 1000-character preview/prepared prompt.
5. Drop a POST response after the real operation was accepted, then reload.
   Opening the drawer performs inspection/GET reconciliation, not a new command.
   For an incomplete handoff with generation already advanced, explicitly click
   **核对／继续完成原操作**: require GET of the same operation and matching full
   hash before POSTing byte-equivalent original JSON (same old head/key/body).
   Count the actual SDK call once; metadata-only roll-forward is not a rerun.
   A missing ID must be discovered from the original-key inspection first.
6. Delay a response/hash, then switch conversation or pair a different actor.
   Release it (including a late 401): no forced selection, overwritten draft,
   deletion of another pending record, or clearing of the new actor. A finished
   older operation cannot open a target after the user moves to a later unrelated
   source generation. Unknown or malformed proofs retain the old outbox.
7. Exercise **停止当前原生分支执行** during real pending work. This calls the
   existing `client.stop` path and awaits host/native joining. A cancelled signal
   alone must not read as rollback; only the checked non-application proof shows
   **已核验分支操作未应用**. No auto-retry follows failure/unknown/cancellation.

Also test narrow viewport, keyboard focus, empty/busy/unverifiable head, all-entry
view, pagination across hidden parents and stale cursor/head rejection. Head
identity includes selected leaf/context, not just the file tail. The display
bound is 1000 entries/1,000,000 preview characters; reaching it must not merge
unbounded or conflicting pages. Existing settings/manual-compaction controls,
sources, drafts and legacy/prototype pages remain independently usable.
