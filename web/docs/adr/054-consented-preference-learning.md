# ADR-054: Consented low-frequency invitations and accumulated preference learning

- Status: Implemented; targeted Core/HTTP/Web and real Pi/PDF browser journey verified; full acceptance limits below
- Date: 2026-09-09
- Extends: ADR-014/015/042/043/047/050/052

## Product decision

Advance beyond a separate candidate for every single choice: automatically accumulate explicitly future-eligible presentation choices across independent research investigations, propose a preference only after a fixed conservative rule, and require separate human confirmation before activation. Keep the existing single-choice `product-probe.v1` behavior and receipts intact. This is a new product learning surface, not inferred personal traits, a new Agent Loop or unrestricted behavioral surveillance.

An independent default-off setting allows occasional comparison invitations. Existing per-conversation `contributeToFuture` still gates all new contributions, and `useExisting` independently gates application. Enabling invitations does not enable either existing switch. Merely viewing an answer/PDF, scrolling, closing a drawer, ignoring an invitation or declining one never becomes a positive/negative preference observation. Disabling invitations stops future invitations, not existing explicit preferences.

## Quiet, durable invitation cadence

Only a newly completed, privately published and currently authorized original Answer can trigger an automatic invitation, after at least three completed submissions in that investigation's conversation. Do not scan old history and manufacture invitations on GET/reload, source preview, compaction or branch inheritance. The host runs a bounded optional hook after durable completion; failure/capacity/permission loss cannot downgrade the Answer or block ordinary chat.

Store a reference-only invitation and its reservation in the existing profile journal. It is a reservation, not proof the user saw or understood anything. One shared automatic-calibration slot per profile/epoch/Investigation may be occupied by a legacy automatic Probe or a new invitation, never one of each. Apply a profile-wide 10-minute invitation cooldown as an initial conservative product constant, not a proven optimal frequency. Existing pending/decided/forgotten learning groups or existing preferences on the same workspace axis suppress redundant invitations. Browser rendering is a dismissible inline invitation; no automatic modal or extra model call. Opening it explicitly prepares the same controlled answer-order comparison. Manual learning comparisons remain available without waiting for invitation cadence.

## Accumulation and provenance

The new learning comparison preserves ADR-047's complete same Answer/Evidence/uncertainty/conflict material and deterministic renderer recipes; it has a separately tagged stable Probe identity so a previous v1 choice is not silently reinterpreted. Both variants retain original-PDF citations. Left/right order is fixed once, and only a concrete variant plus explicit workspace/future scope enters accumulation. Turn-only, both/neither/dismissed choices never contribute to future preference formation.

Each new choice atomically commits its Choice, Observation, exact original-command receipt and, when warranted, one new immutable candidate in the same profile transaction. Private receipts include trusted original Answer references: original conversation/message/manifest/source-scope IDs and material/native-text hashes, profileEpoch and Probe ID; no Answer text, PDF, Locator or Note prose is copied into the profile.

Group by profile epoch, workspace, answer-order axis and task mode. Count distinct original Investigation IDs, not clicks, turns, forked views or duplicate Probe IDs. At least three independent investigations must support the same variant, with no opposite eligible choices in that group, to form one low-risk ordinary workspace candidate. Keep opposing choices visible in the governed group state; never filter an unauthorized counterexample out to improve apparent agreement. This threshold is a conservative rule, not statistical confidence or demonstrated utility. Workspace confirmation is an explicit choice to adopt a default; three explore tasks do not prove it suits verify/publish tasks.

The candidate's support snapshot is immutable. Earlier receipts with no candidate keep that original null result. Later opposing choices change current group eligibility and block confirmation; they do not rewrite old receipts or silently revoke an already explicitly adopted preference. Pending, accepted, rejected and forgotten groups suppress duplicate candidate generation. A single-memory forget must not recycle the same old observations merely because profileEpoch was unchanged. Drift/relearning requires its own explicit reviewed policy, not a hidden fresh ID.

## Authority, compatibility and privacy

Before counts, invitations, group/candidate display or confirmation, authorize every contributing original Answer/Probe and validate its private publication, exact material and current source access. Bounded enumeration is explicit; inaccessible, missing, changed or over-budget membership produces an unavailable group, not a filtered success. Do not relabel historical origins or silently admit their documents to the current Pi frame.

New commands freeze actor-bound current binding/generation, profile erasure epoch, full body/key and relevant settings/policy/candidate/group versions. Original-key receipt queries are read-only; unknown requests are not auto-rebased, retried or assigned new keys. Settings/choice/confirmation effects and their receipts commit together. Generic legacy candidate review and raw-choice APIs must recognize learning provenance and cannot bypass the new group/current-authority checks. Existing v1 candidates retain their original behavior.

Use the existing profile database and hash-chained journal, with reference-only learning metadata rather than a second memory store. Review a backup-first metadata schema v2→v3 upgrade so older programs reject data they cannot safely interpret; preserve existing profileEpoch, rows, hashes and v1 receipts. New records participate in reopen verification, one-vote checks, bounded export and the existing truthful logical-forget/profile-erasure handling, including managed backups/WAL. Tests use temporary databases only; no live-user-data migration is performed here.

## Required verification and remaining scope

Verify default-off and independent consents, after-completion-only invitation generation, quiet UI, one automatic slot across tabs/restarts/legacy Probes, cooldown, close/dismiss without preference inference, three independent investigations, duplicates/forks/mixed task modes, opposite choices and inaccessible counterexamples. Exercise transaction rollback, exact-key recovery before/after later aggregation, old-review/raw-write bypass rejection, source/actor/policy/epoch races, export/forget/erase/reopen and old schema migration failure.

Use a real Pi/PDF browser journey through invitations, controlled choices, accumulation, independent confirmation and observed subsequent use, plus legacy Probe regressions. Model responses in deterministic integration tests are explicitly scripted. No new paid-model calls are authorized by this ADR. Longitudinal benefit, other presentation axes, passive behavioral inference, autonomous activation, drift/relearning and complete recovery/native-parity/public-release gates remain in R4–R7.
