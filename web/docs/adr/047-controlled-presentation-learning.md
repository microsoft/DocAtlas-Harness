# ADR-047: Controlled presentation choices and explicitly confirmed learning

- Status: Accepted bounded implementation; real Pi/PDF choice-confirm-use journey verified, full acceptance limits below
- Date: 2026-09-09
- Extends: ADR-014/015, ADR-039, ADR-042/043

## Decision

Connect the existing Probe → Choice → Observation → pending Candidate → explicit confirmation → MemoryVersion lifecycle to the real product. The first axis is `answer-order`: show the whole saved answer before or after the whole Evidence section. This is a controlled renderer comparison, not two model-generated answers. Other learning axes, automatic scheduling and longitudinal utility acceptance remain in the complete plan.

One authorized, privately published, checkpoint-backed AnswerManifest and its native text hash define the material. Both variants reuse the complete same blocks, citation relations, Evidence, uncertainty/contested/unresolved states and verification warnings. No paraphrase, truncation, filtered counterevidence, independent model calls or alternate source scope is permitted. Bound the eligible material before offering this optional interaction; oversized material leaves ordinary reading intact.

Core deterministically derives the material digest and both recipe identities from actual content and section orders. It verifies the recipes against that material; equal caller-declared digests alone are not accepted. Probe backbone uncertainty/conflict references use the corresponding existing answer-local segment/citation IDs, not invented M4 records. A digest witnesses invariant presentation inputs, not factual truth or human comprehension.

An Answer may have real Read Evidence without any saved M4 ClaimVersion. The Probe's exact `claimVersionIds` set may therefore be empty; the existing v1 schema's minimum is relaxed from one to zero for this additive capability, while at least one real EvidenceAtom remains required. Existing nonempty payloads retain their meaning; old binaries may reject the newly supported empty set. Do not fabricate Claim IDs merely to satisfy the earlier shape requirement.

The profile ledger stores existing reference-only Probe/Choice/Observation/Candidate objects and an internal, hash-verified choice receipt in its existing journal. It never stores a second Answer/Evidence database, source text, PDF bytes or Locator objects. The ephemeral product view obtains material again from the authorized original Answer. Stable Probe identity binds profile erasure epoch, original conversation/message/manifest and the material/recipe version; randomized left/right order is persisted independently of the variant keys.

## Consent, transactions and recovery

Inspection is read-only and never creates a Probe or calls a model. The user opens “compare two presentations” from an actually saved Answer. New Probe/Choice writes require the current conversation's explicit contribution permission and its expected policy version, plus actor/binding/generation and persistent profileEpoch checks. UI opening, closing, scrolling or merely receiving a suggestion is not feedback.

Choice defaults to this turn. Only an explicitly selected variant with explicit workspace scope may create a pending ordinary, low-risk candidate in the product's first implementation. Both/neither/dismissed and turn-only choices have session-only observation retention and no candidate. Workspace context on an observation is not an activation scope. The Core may retain existing broader typed scopes for legacy callers; the product does not silently infer global preference.

Choice, linked observation, optional pending candidate and exact command receipt commit in one `BEGIN IMMEDIATE` transaction in the existing profile database. Epoch, contribution/policy CAS, exact Probe membership and synchronous host authority are checked inside it. One controlled Probe receives at most one durable choice, including concurrent different keys; half-written legacy records are not treated as controlled receipts. Legacy raw choice behavior remains compatible except that it cannot overwrite an already-controlled choice.

The original product body hash/key and complete input digest are retained in the internal receipt. Observation provenance remains `preference-probe`; it is not relabeled as a UI-action merely to carry request metadata. Exact receipt replay still checks epoch/current authority, but does not demand renewed contribution permission or the old policy version: reconciliation of an existing result is not a new contribution. A newer erasure epoch always rejects old learning writes and receipts.

Candidate acceptance/rejection is a separate authenticated product command with candidate version CAS and whole-product-body idempotency. It reauthorizes the original Answer/Probe, limits acceptance to the same fixed low-risk effect and workspace scope, and never accepts arbitrary model/browser memory content. Accepted candidates use the existing memory creation rules, status, conflict handling, pause/edit/forget/export and observed-generation application. Choice is not activation, and activation is not an observed MemoryUse or proof of usefulness.

The browser freezes original actor/workspace/conversation/binding/generation/profileEpoch/message/Probe/material and command body/key. Reload only inspects state and may reconcile a hash-matching receipt; retry requires an explicit action. No new key, updated epoch, latest Answer or changed candidate may replace an uncertain request. Original PDF citations remain the only citation target.

Exports include eligible unpromoted candidates/observations and retained choices, with JSON and Markdown sharing the same privacy-filtered bundle. Session-only/ineligible records remain excluded from future-memory exports. Deleted-memory provenance is not resurrected by the broader export; profile erasure also removes the new internal receipt along with all managed profile content.

## Required verification

Verify complete variant equivalence including counterevidence/unknowns, wrong material/recipe/hash rejection, exact original Answer publication authority, late actor/binding/profile/policy changes, one-choice concurrency and transaction rollback, original-key replay after candidate promotion, erase/reopen/export behavior, and a real Pi/PDF browser choice → pending candidate → confirmation → observed generation journey. Preserve native Pi tools/history/loop and the default quiet chat-first interface. Record full and focused results honestly; this ADR does not complete automatic inference, scheduling, longitudinal efficacy, native parity or production deployment.
