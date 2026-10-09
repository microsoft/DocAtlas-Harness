# Grounded Web post-migration code audit

Base: `0eff3e6`, branch `feat/grounded-web`. Scope: the independent local Web
application, its live grounding closure, tests and verification tooling. The
original Python CLI/package/lock and source video workspace remain untouched.
No remote push or live database migration is included.

Outcome: the independent Web audit is locally verified. Full checks and the
stable-dependency 56-journey browser rerun pass without skipped tests. Original
CLI dependency advisories remain an explicit, separately scoped pre-merge task;
this is not whole-repository security approval.

## Working gates

- Run static checks and dependency/dead-code analysis; classify dynamically
  loaded entries and exported compatibility ports before removing anything.
- Measure coverage instead of inferring it from test counts. Add regression
  cases for real failures and safety/lifecycle boundaries; do not manufacture
  a whole-product 100% claim from a selected subset.
- Review and complete optional tree/combined retrieval, result validation,
  cancellation, bounded pagination and per-question UI/outbox behavior.
- Retire only confirmed unreachable UI from ADR-062. Keep its durable records,
  server APIs, shared learning presentation, privacy controls and active tests.
- Run the full locked build/check and live browser suite after changes, verify
  the original CLI remains unchanged, and re-audit new secret-scan findings.

Findings, changes, exclusions and exact verification results are recorded here
as the audit progresses. Public deployment, new providers, full crash recovery
and real-model/corpus quality need their own explicit acceptance and are not
silently promoted by this code-cleanup task.

## Confirmed findings and repairs

The initial full JS/V8 run passed 2739 tests. Its source-only report was 73.53%
lines / 62.67% branches; this is not a 100% claim. It missed execution imported
through built workspace libraries. TypeScript library source maps and coverage
input/remapping are now explicit, so a subsequent report includes those paths
without replacing actual packaged integration tests with source aliases.
Browser-only effects and isolated subprocesses still have their own journey
and lifecycle gates; percentages here must not imply they were instrumented.
Python's initial 1474 tests passed with branch coverage enabled (78.46% combined
statement/branch coverage). Generated schemas and exact-pinned vendor sources
use their dedicated byte/contract tests and are excluded from owned-code metrics.

Nine failing regression cases established five missing boundaries:

1. Empty candidate previews could return a non-advancing cursor.
2. Preview character counts did not bound the complete native JSON envelope.
3. An original-PDF hash could change during a model call without a final hash
   comparison if the representation frame itself had not changed.
4. Invalid planner JSON/schema errors were misclassified as an unavailable
   provider instead of invalid output.
5. Tree pages were not compared against the same manifest's PDF page count.

The fixes preserve legacy default FTS, exact consumption, immutable nodes and
Read-as-Evidence. Pagination and Pi now share one serialization budget. A
partial catalogue/preview uses existing `completeness: partial`; v1 `truncated`
means a real remaining snapshot page and always carries its valid next cursor.
No wire version, storage schema, invented cursor or implicit model replay is added.
New tests cover these repairs plus cache eviction, expiry, authorization,
full-operation timeout/actual join, Unicode and independent-route behavior.

## Reviewed removals and tool configuration

ADR-062's unreachable stateful `LiveProbe` controller and retired/skipped browser
journey were removed, along with their unused CSS. They remain recoverable from
`0eff3e6`. The pure comparison/evidence view is retained as
`ProbePresentations.tsx` and still used by Learning. Learning's actual consent/
scope/explicit-submit controls replace the obsolete control-rendering tests.
All legacy Probe API/outbox/state tests, stored records and server interfaces
remain. No durable data, actor permissions or safety/recovery gate was removed.

Knip is pinned to 6.40.0 (outside the package release-age safety window); no
release-age bypass is retained. Explicit roots describe actual HTML entries,
runtime worker entrypoints, crash fixtures, tests and verification scripts.
The only dependency-reference exceptions are `pdfjs-dist` and Noto Sans SC in
the root asset-preparation script: both are resolved deliberately through
`apps/web/package.json`, where they are declared, not installed as hidden root
dependencies. Global exported Core/contract compatibility APIs are not deleted
merely because this one application does not consume every export.

## Repeatable verification gates

`scripts/check.sh` now runs Knip and V8 coverage as part of the ordered JS
build/type/test graph, then Ruff/mypy, branch-aware Python coverage and the
existing Flash/packaged-sidecar checks. Coverage reports are ignored local
artifacts; CI retains only those reports for seven days. No provider call,
credential, live state or browser transcript is added to those artifacts.

The focused 61-case Search/presentation run passes with 100% statements,
functions and lines, and 99.10% branches (222/224), including the built public
Core API's combined retrieval and typed planner-error behavior. The remaining
logical branch is the comparator's defensive equal-ID result after ID
deduplication, represented by both compiler mappings. Keep a real total
comparator; do not invent a production state to claim 100% branches.
The per-module gates require 100% statements/functions/lines, at least 99%
Search branches, and 100% of the shared envelope-budget helper's branches.
Python's measured 78.46% combined coverage has an explicit 78% floor.
The full remapped JS baseline was 73.16% statements, 71.69% branches, 69.75%
functions and 77.79% lines; non-regression floors are 73/71/69/77 respectively.
All 226 report paths resolve to owned `src` files, with no residual `lib` or
generated-schema entries. Source and compiled call sites can have distinct
mapped function/branch ranges; these are instrumentation metrics, not a claim
of exactly that many unique source decisions. Browser-rendered effects remain
honestly uninstrumented here and are not excluded to inflate the percentages.

A first full remapped-coverage run exposed a fixture-timing failure: preparing
32 of a 64-transaction Learning history inside the assertion phase exhausted
the five-second test deadline under instrumentation. Both genuine history
batches now run in setup hooks; the actual 65th opposing vote and all boundary
assertions retain their original deadline. No global timeout, production
deadline, real receipt or isolation check was relaxed.

The initial tooling-only lock comparison preserved runtime versions. A later
runtime advisory audit required the explicit minimal security maintenance
below; it is not an incidental update from installing coverage tools. Knip,
V8 coverage and pytest-cov remain pinned, and no release-age bypass is used.
The original CLI/package/lock/tests remain byte-identical to official main
`5a3d67e0e2a5736198cc7a88d8945b0c94ef3636`; its 168 tests pass again in this audit.

The final tracked-file secrets gate passes with 1662 audited non-secret findings.
The initial 75 new findings were matched by their SHA-1 finding identity to exact
`sha512-…` dependency-integrity literals on the corresponding pnpm lock lines;
none were blanket-accepted as arbitrary high-entropy strings. Detectors and
code exclusions are unchanged. The hook refreshes finding line numbers and
records its own baseline filename, already excluded by the original policy.
No Web-directory exemption or disabled detector was added.
The security follow-up added 26 individually verified package/extension or
vendor-provenance checksums and retired 8 obsolete package checksums. Vendor
values were checked against actual pinned-source/generated bytes and the
reviewed manifest before being classified as non-secrets.

## Runtime security follow-up (ADR-065)

The first Node runtime audit found 22 advisories across eight packages. The
final graph replaces only these eight versions; all other package integrity
values remain unchanged. Pi 0.85.1, its exact patch and its original provider
capability closure remain present. All replacements support Node 22.19.0 and
were outside the configured release-age window.

| Package | Imported | Reviewed fix |
| --- | --- | --- |
| ajv | 8.17.1 | 8.18.0 |
| fast-uri | 3.1.6 | 3.1.8 |
| undici | 8.9.0 | 8.10.2 |
| ip-address | 10.7.0 | 10.7.1 |
| brace-expansion | 5.0.9 | 5.0.12 |
| hono | 4.13.5 | 4.13.7 |
| proxy-addr | 2.0.7 | 2.0.8 |
| @modelcontextprotocol/sdk | 1.30.0 | 1.31.0 |

Resolving the optional Google-provider MCP peer initially pruned its installed
closure. That intermediate graph was rejected. The exact Pi AI package
extension explicitly retains the peer, and `check:compat` now verifies actual
provider-to-MCP resolution without executing factories. pnpm 11 also performed
an implicit install during `exec` after the lock changed; the overlapping
browser run is not accepted as final verification. Re-run after stable frozen
installation, not with a moving dependency graph.

The first Python audit exported the virtual uv root and therefore audited no
dependencies; its empty success is **not** acceptance. Exporting the named
sidecar member found 12 advisories in pypdf 6.15.0 and PyPDF2 3.0.1. The sidecar
now uses pypdf 6.19.0 and removes PyPDF2. The new five-file import-only Flash
patch preserves all function/class ASTs, original upstream hashes and the
numbered-heading patch. Generated files were produced only by the reviewed
generator. The dependency version participates in a new provider fingerprint;
no existing tree, source revision, Evidence or journal is rewritten.

Both current Web runtime audits report zero known vulnerabilities: 365 Node
dependencies including the retained provider closure, and 12 explicitly
enumerated Python runtime dependencies. Static contract regeneration remained
byte-identical. Network audits are added to CI separately from the network-
isolated local check. No advisory is ignored. The 61 focused parser/source/
heading tests include 20 new import-manifest, atomic rejection, AST preservation,
dependency-removal and fingerprint cases.

One intermediate browser journey failed while reading a released Chromium
response body before any human command. Its startup helper now uses the shared
network observer for the actual GET, captures the original bytes once and
forwards them unchanged. It neither replays a product operation nor substitutes
fixture JSON. Tests, timeouts and the real application remain active.

The original CLI was audited read-only as a separate baseline: **37 advisory
matches in 6 packages** (anyio 4.13.0, docling 2.97.0, fsspec 2026.4.0,
PyJWT 2.13.0, pypdf 6.16.1, urllib3 2.7.0; 135 dependencies checked). Those
dependencies were not changed. This is a separate pre-merge security task,
not a claim that every advisory is reachable in the application. In particular,
Docling upgrades need their own parsing/performance comparison and one PyJWT
advisory reports no fixed version. Do not describe the whole repository as
security-clean or ready to push on the strength of the Web audit alone.

## Verification commands and results

All commands use Linux, Node 22.19.0, pnpm 11.7.0, CPython 3.12.12 and uv 0.9.21.
Commands are run from `web/` unless a different directory is named.

- `bash scripts/pnpmw install --frozen-lockfile`,
  `env -u VIRTUAL_ENV uv sync --locked --all-packages --all-groups`,
  `env -u VIRTUAL_ENV uv lock --check`, and
  `bash scripts/prepare-test-source.sh`: passed.
- `bash scripts/pnpmw run check:clean-host`: invokes the actual
  `bash scripts/check.sh` through the shared namespace guard. Ordered build,
  Oxlint, Knip, TypeScript, generated-contract checks, **2782 JS tests**,
  coverage thresholds, Pi's 24-file fingerprint, cross-language protocol,
  Ruff, mypy and **1494 Python tests** passed. Python combined statement/branch
  coverage is **78.58%** in the final clean-host run. Flash's 83 files / 25
  deterministic functions and all 109 sidecar wheel source/data/license files
  verified; the complete command exited successfully.
- Final JS metrics: statements **73.18%**, branches **71.70%**, functions
  **69.79%**, lines **77.80%**. The Search module has 100% statements/functions/
  lines and 99.09% branches in that full report; the shared envelope helper
  has 100% in all four metrics.
- `bash scripts/pnpmw run test:live:clean-host`: **56 passed, zero skipped**
  (17.8 minutes) after the final frozen dependency graph, parser migration and
  response-observer repair. This supersedes the intermediate 55-pass/1-fail run.
- `bash scripts/pnpmw run test:live:clean-host e2e/live/human-research.pw.ts --grep 'authors all four' --repeat-each=3`:
  **3 passed**, with the stable security dependency graph and actual response
  forwarding; no test retries or product-operation replays were introduced.
- `bash scripts/pnpmw audit --prod`: zero Node runtime advisory matches, with
  the original provider dependency closure retained.
- `env -u VIRTUAL_ENV uv export --locked --package docatlas-dsh-sidecar --no-dev --no-emit-workspace --format requirements-txt --output-file /tmp/docatlas-review-sidecar-final-requirements.txt`, then
  `env -u VIRTUAL_ENV uvx --python 3.12.12 pip-audit==2.10.1 --progress-spinner off --disable-pip --require-hashes --strict --format=json -r /tmp/docatlas-review-sidecar-final-requirements.txt`:
  all **12 actual sidecar dependencies** audited, zero known vulnerabilities.
- From the repository root:
  `env -u VIRTUAL_ENV uv run --locked --python 3.12.12 --extra dev pytest -q`:
  **168 passed**. `git diff --quiet 5a3d67e0e2a5736198cc7a88d8945b0c94ef3636 -- docatlas tests pyproject.toml uv.lock`:
  no original CLI/package/lock/test changes.
- `env -u VIRTUAL_ENV uvx --python 3.12.12 --from shellcheck-py==0.11.0.1 shellcheck scripts/check.sh scripts/prepare-test-source.sh scripts/run-docatlas-web.sh scripts/bootstrap-node.sh scripts/pnpmw scripts/tool-bin/pnpm`:
  passed.
- From the repository root:
  `env -u VIRTUAL_ENV uvx --python 3.12.12 check-jsonschema==0.38.0 --builtin-schema vendor.github-workflows .github/workflows/ci.yml .github/workflows/web.yml`:
  passed; this validates workflow configuration, not a claim of a remote CI run.
- From the repository root:
  `git ls-files -z | xargs -0 env -u VIRTUAL_ENV uvx --python 3.12.12 --from detect-secrets==1.5.0 detect-secrets-hook --baseline .secrets.baseline`:
  passed after auditing new findings and staging the line-number refresh.
- `env -u VIRTUAL_ENV uv run --locked --project python/docatlas-sidecar pytest python/docatlas-sidecar/tests/test_flash_parser_patch.py python/docatlas-sidecar/tests/test_flash_numbered_patch.py python/docatlas-sidecar/tests/test_flash_vendor_source.py -q`:
  **61 passed**. The generator's Ruff check and 88-column formatting check,
  `git diff --check`, and unchanged wire/schema/Pi-patch/original-CLI checks
  also passed.

The existing Vite large-chunk and Node SQLite experimental warnings remain
visible. They are not suppressed or counted as performance/corpus acceptance.
No Azure smoke, remote push, live data move or public deployment was performed.
`git ls-remote origin refs/heads/main` still reports the exact comparison base
`5a3d67e0e2a5736198cc7a88d8945b0c94ef3636`; no upstream checkout was modified.
