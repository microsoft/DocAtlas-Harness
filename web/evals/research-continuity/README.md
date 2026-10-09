# Research continuity longitudinal gate

This gate checks whether prior research remains a bounded lead instead of
becoming evidence by recall alone. It exercises the runtime service with the
project-authored M5 fixtures in
`contracts/fixtures/m5/research-continuity.valid.json`; those synthetic fixtures
are covered by this repository's MIT license and contain no third-party text.

## Executable scenarios

| Scenario | Expected state | Evidence/scope oracle |
|---|---|---|
| Financial filing, unchanged covenant basis | `continuing / reverified` | Resolved prior and current Evidence from exact admitted revisions |
| Contract renewal changes a termination window | `changed / reverified` | Explicit old/new clause Evidence; no inference from filenames |
| Research replication disputes an earlier result | `conflicted / reverified` | Original, replication, and response representations remain distinct |
| Audit workpaper cannot admit the historical source | `unknown / outside-scope` | No cached text or prior conclusion upgrades the result |
| Prior record has no source provenance | `unknown / missing-source` | Empty provenance never becomes a comparative conclusion |
| New contract revision | exact impact scan | Affected Claim is stale, unrelated Note is unaffected, unavailable Artifact reports missing source |

The safety mutations cover cross-Workspace rejection before prior-record
lookup, source-scope non-expansion, missing and stale Evidence, deleted records,
record-as-Evidence self-support, changed snapshots, and cursor reuse with a
different Workspace or revision identity.

Run the gate from the workspace root:

```sh
bash scripts/pnpmw exec vitest run plugins/docatlas-dsh/test/continuity-longitudinal.spec.ts
```

## Pass criteria

- all four business-state classifications are correct;
- zero comparative links are committed after a scope, missing, stale, or
  self-support violation;
- zero prior-record lookups occur after an authenticated cross-Workspace scope
  mismatch;
- every requested revision-impact record is classified exactly once, in stable
  request order;
- changing the record snapshot, Workspace, or full revision identity invalidates
  a continuation cursor.

These tests evaluate admission and provenance safety. They do not score the
model's semantic judgment about whether prose truly means continuing, changed,
or conflicted; that requires licensed document pairs and an adjudicated answer
set in a later corpus-level evaluation.
