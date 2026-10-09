# ADR-065: Reviewed runtime security maintenance

Date: 2026-10-09

Status: implemented and locally verified for the independent Web audit
requested by the user; not public-deployment or corpus-quality acceptance.

## Context

Locked runtime audits found 22 Node advisories across eight packages and 12
Python advisories across pypdf 6.15.0 / PyPDF2 3.0.1. The uv root is virtual;
auditing it alone exports no dependencies, so the sidecar member must be named
explicitly. PyPDF2 is no longer maintained; its advisory points to a fix in its
pypdf successor, not an installable newer PyPDF2 release. Ignoring the advisory,
dropping provider peers, changing upstream source pins or moving live data is
not the maintenance decision.

## Decision

Keep the Pi 0.85.1 release and its exact reviewed 24-file patch. Update only the
eight affected Node packages within their existing majors, with explicit pins
and Node 22.19.0 compatibility. Anchor the previously installed MCP peer in
Pi AI's dependency closure so resolver changes do not remove native provider
capability. Verify actual provider peer resolution without invoking factories.

Use one maintained, pinned pypdf 6.19.0 backend for PDF parsing and Flash raw
object access; remove PyPDF2. Preserve the finite PageIndex commit and original
source hashes. A separate exact-hash manifest permits only the two reviewed
import forms in five allowlisted generated files. The generator verifies
input/output hashes, exact occurrence counts and otherwise identical ASTs
before writing anything. Do not hand-edit generated vendor files, change the
numbered-heading patch or claim a new upstream release.

The Flash dependency fingerprint changes from PyPDF2 to pypdf and records its
actual installed version. New navigation generations therefore get a new
identity. Existing trees, Evidence, source revisions and journals remain
immutable; no store migration, implicit source activation or old-generation
rewrite is introduced. Native PDF work remains in the same one-file sandbox
with CPU/memory limits and actual pidfd/namespace joins.

Wire schemas, protocol fields, Read authority and host-owned credentials do not
change. Regenerate bindings only through the existing generator and verify
schema/validator byte differences explicitly. Re-run full locked checks,
PDF/Flash matrices, browser grounding and native lifecycle journeys after the
dependency graph is stable. Keep network vulnerability audits separate from
the network-isolated local verification host; never suppress their failures.

## Limits

The original CLI/package/lock remains an independent upstream baseline. Its
pypdf 6.16.1 also falls below later advisory fixes; a separate original-CLI
dependency update is needed before claiming repository-wide dependency safety.
The read-only original-CLI audit found 37 advisory matches across six packages,
not only pypdf. This Web maintenance does not silently authorize those changes, prove arbitrary
document/OCR quality, or close public deployment and general recovery gates.
