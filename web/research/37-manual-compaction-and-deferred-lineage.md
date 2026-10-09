# Manual compaction and deferred native lineage seams

Internal host review for batch 23. This note is not acceptance of navigation/fork,
does not change their pending gates, and does not delay same-session compaction.

## Same-session manual compaction

Keep the binding, generation, Pi session and existing checkpoint/publications.
Use the native-operation writer/barrier, real SDK compaction, auxiliary model
purpose and independently verified intent/compaction/commit metadata. Revoke the
old DocumentSession invocation before starting compaction; only a subsequently
consumed explicit question can install another source frame. A summary is native
context, not an Answer publication, successful Read, Research capture or MemoryUse.

Joined cancellation or SDK rejection can settle not-applied only with an exact
native intent + terminal marker and no intervening native entry. This establishes
that compaction was not applied, not that model cost or extension side effects
were rolled back. Missing proof or unjoined work stays unknown. A successful
compaction entry remains authoritative even if a later SDK hook rejects.

## Navigation/fork: concrete seams to address separately

1. **Selected head is not a file seal.** `inspectNativeSession` seals the last
   JSONL entry; `openNativeSession` and native-control prefix verification expect
   the SDK leaf to equal it. A selected older branch leaf needs an independently
   durable selected-head proof. Do not truncate/rewrite the original file or
   fabricate a message to make these identities match.
2. **A binding rebind is not runtime replacement.** RuntimeCatalog fixes
   conversation/binding/native-session identity and rejects the new binding.
   RuntimeManager caches the old coordinator. A future manager handoff must
   reserve admission, join old worker/native/document work, seal the real file,
   persist the operation/origin, install ControlStore + catalog state through
   exact CAS/recoverable phases, retire old observation/history handles, and only
   then acquire the next writer. Reject queued/unknown work, stale proof, foreign
   writer or unclean catalog. No PID/TTL takeover.
3. **Visible history needs a proved origin.** `latestCheckpoint` selects the
   largest completed prefix in the current generation. After rebind it is empty;
   without rebind it may select an abandoned sibling. Resolve completed
   checkpoints only on the proved selected ancestry, with separate native-view
   identity if no completed Answer exists at the selected head. Invalidate old
   cursors and SSE streams; keep uncertain client bodies in their original scope.
4. **Old publication remains old.** AnswerReceipts uses the original binding
   key and full owner tuple, and ProductAnswers requires its original completed
   generation/checkpoint. Preserve these records. Introduce a read-only lineage
   resolver carrying original conversation/binding/generation/session/message/
   checkpoint + source permission checks; do not copy old Read attestations or
   publish them under the new run. Forked native entry IDs alone are insufficient.
5. **Fork creates a new owned conversation/session.** Freeze destination identity
   and selected native ancestry in the original operation receipt. Verify actual
   SDK-created header/entries, exclusive destination file, immutable source bytes,
   parentage and selected leaf before installing the child catalog. An existing
   child succeeds only with the same original creation/proof. Do not use filename
   discovery, overwrite a target or infer success from current contents.
6. **Execution frames are not inherited references.** DocumentApplication
   invalidates by generation; Research `consumedFrame` additionally requires an
   executing receipt. Future handoff must explicitly await retired backends and
   revoke old frame/personalization uses. Historical Notebook/Answer/Claim access
   can follow authorized original references, but fresh target research/source
   frames require a new exact native consumption. Research policy is per
   conversation, so a child cannot silently copy consent or source selections.

The existing answer projector intentionally leaves a publication gap when a
compaction/branch-summary/steering boundary lies inside the current user/answer
interval. Preserve that rejection until a separate attribution proof exists;
earlier historical Evidence is never a new successful Read.
