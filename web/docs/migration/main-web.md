# Official main: independent Grounded Web migration

Authority: user approval 2026-10-09 and ADR-064. Destination is the independently
versioned `DocAtlas-Harness-Web/`, branch `feat/grounded-web`, based on official
main `5a3d67e0e2a5736198cc7a88d8945b0c94ef3636`. Original checkouts and live state
stay untouched. No remote push is included in this implementation run.

| Work | State | Required evidence |
| --- | --- | --- |
| M1: source snapshot, standalone web closure and root launcher | locally accepted | 938-file source closure; official main ancestry; independent frozen installs/build; original package/lock diff empty; 109-file sidecar wheel and root launcher help verified |
| M2: genuine optional tree/combined Search | locally accepted | product-search v1 and exact-consumption policy; summary/model ports; 34 focused JS cases and final real Pi→Flash→Read→PDF browser passed |
| M3: Office Intelligence typography, palette and layout | locally accepted | local OFL fonts, warm editorial tokens, final 1440/390 EN/中文 accessibility/overflow journeys passed; current screenshots inspected |
| M4: PDF highlight and native lifecycle reliability | locally accepted | all 14 native lifecycle cases passed; immediate Library dismissal in all four closing paths; Map/Note/original/refresh and native history/compaction/fork browser journeys passed |
| M5: documentation, CI, packaging and complete acceptance | locally accepted for this bounded feature | original Python 168 passed; source check.sh: 2939 JS +1474 Python, 1 existing skip; independent check.sh: 2739 JS +1474 Python; final browser: 56 passed, 1 existing retired-UI skip |

Historical baseline, not an acceptance pass: root JS 2906 passed/4 timed out/1 skipped; focused
linux-executor 7 passed/2 timed out; two browser journeys 1 passed/1 failed at
research-map original-source highlight. These observations are baselines, not
proof of new regressions or permission to loosen safety. Web performance/score
equality with CLI is not required. Full public deployment, all-platform native
parity and general crash recovery remain outside this bounded local feature.

Migration test ownership: the legacy-wrapper assertion moves from Core's test
file into the legacy plugin tests, without deleting its assertion. Core's domain
boundary tests therefore travel with Core and do not require the old plugin.

## Verification environment and intermediate findings

Full checks use `bash scripts/pnpmw run check:clean-host`, which executes the
actual `bash scripts/check.sh` with 22 verification mounts and unchanged real
nested namespaces, deadlines and assertions. The ordinary shared host has 6,185
mounts; earlier plain-host suites hit different cumulative native-startup
timeouts and are not relabelled green. See
[the diagnostic record](../../research/66-migration-reliability-diagnostics.md).
This verification setup is not a production performance change.

The first independent full browser run exposed an actual Library dismissal
race, a Chromium response-observation hang, an obsolete missing-citation text
assertion, a newly tucked-away Refresh control and a cold-runtime snapshot wait
started as a DOM-only deadline. Fixes retain all source/PDF/model-count/durability
assertions. That intermediate full run finished with 51 passed, 5 failed and
1 pre-existing skip (the ADR-062 retired standalone Probe panel). Focused
retests passed the four dismissal paths and five research/history/notebook
journeys; compaction then passed separately after the same response-body
observation correction was applied to its submission receipt. The final full
rerun is recorded separately; the intermediate run is not an acceptance pass.

Secret scanning retains the original detectors and scans all tracked Web files.
Exact checksum/canary findings are audited in `.secrets.baseline`, not hidden by
a Web exclusion. The initial full hook passed and an unlisted synthetic canary
was correctly rejected. See [scan review rules](web-secret-scan.md); repeat the
hook against the final source manifest before handoff.

## Exact acceptance commands

All local Python execution uses uv 0.9.21 and CPython 3.12.12. The original
3.10–3.13 CI matrix is preserved, not claimed as locally executed here.

- Source workspace: `bash scripts/pnpmw run check:clean-host` executes
  `bash scripts/check.sh`: 2939 JS passed, 1 existing skip, 1474 Python passed;
  Pi's 24-file fingerprint and packaged legacy Flash checks passed.
- Independent `web/`: `bash scripts/pnpmw run check:clean-host` executes its
  own `bash scripts/check.sh`: 2739 JS and 1474 Python passed, including the
  complete 109-file sidecar wheel inventory/bytes and Flash provenance.
- Independent `web/`: `bash scripts/pnpmw run test:live:clean-host` runs the
  complete browser suite: **56 passed, 1 pre-existing retired-UI skip**, in one
  final run (17.9 minutes). Model fixtures are explicit faux providers; no Azure
  calls. No test was newly skipped or retried to obtain this result.
- Original repository root: `env -u VIRTUAL_ENV uv lock --check` and
  `env -u VIRTUAL_ENV uv run --locked --extra dev pytest -q`: 168 passed.
  `uvx ruff==0.16.5 format --check --extend-exclude web .`,
  `uvx ruff==0.16.5 check --extend-exclude web .`,
  `env -u VIRTUAL_ENV uv run --locked --with mypy==2.3.1 mypy docatlas`, and
  `uvx bandit==1.9.4 -q -r docatlas -x docatlas/_vendor` also passed.
- Original repository root: `uvx check-jsonschema==0.38.0 --builtin-schema vendor.github-workflows .github/workflows/*.yml`
  passed. `uvx --from shellcheck-py==0.11.0.1 shellcheck scripts/*.sh web/scripts/check.sh web/scripts/prepare-test-source.sh web/scripts/run-docatlas-web.sh web/scripts/bootstrap-node.sh web/scripts/pnpmw web/scripts/tool-bin/pnpm`
  passed.
- `git diff --cached --check` passed. Markdown hard breaks/historical EOF and
  one exact generated vendor EOF are explicitly retained via `.gitattributes`;
  ordinary code whitespace was cleaned in the source before migration.
- After the full suite, from the independent repository root:
  `bash web/scripts/pnpmw install --frozen-lockfile`,
  `env -u VIRTUAL_ENV uv sync --project web --locked --all-packages --all-groups`,
  `bash web/scripts/pnpmw run check:compat`, and
  `bash scripts/run-docatlas-web.sh --help` all passed. The actual root forwarder
  completed its normal standalone build hooks, without starting a service or
  obtaining a model token. Existing large-bundle/experimental-SQLite notices
  remain warnings, not concealed failures or performance claims.

Frozen dependency installation and all builds stay inside the independent Web
workspace. Tests never rebuild shared outputs while another test consumes them.

Final local evidence: `/tmp/docatlas-main-web-acceptance-check.log`,
`/tmp/docatlas-main-web-acceptance-browser.log`, and
`/tmp/docatlas-migration-source-final-check.log`. Browser screenshots are under
`web/.cache/playwright-clean-host-results` in the independent checkout (ignored,
not product data). The final source refresh changes only acceptance documents
and their manifest hashes; the tested runtime, contracts, tests and lockfiles
remain identical. This branch is ready for review/integration, not a pushed or
publicly deployed product. Moving existing live state remains a separate task.
