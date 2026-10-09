# Reproducible development environment

The tool versions are unchanged during the DocAtlas-first reorganization. apps/web now contains a standalone prototype;
the production server/Core/Pi/Reader packages remain ownership scaffolds. Current Agent runtime checks still exercise DSH; the Pi source below is a
reviewed input, not an installed or validated product runtime. See [ADR-021](adr/021-docatlas-first-pi-runtime.md).

## Fixed tools

| Tool | Version | Source of enforcement |
|---|---:|---|
| Node.js | 22.19.0 | `.node-version`, root/package engines, `scripts/pnpmw` |
| pnpm | 11.7.0 | `packageManager`, Corepack, environment check |
| CPython | 3.12.12 | `.python-version`, uv-managed interpreter |
| uv | 0.9.21 | `uv.toml` required version |
| Pi source candidate | v0.85.1 / `d981de1…` | `sources.lock.json`, `.sources/pi`, `compat/pi/README.md` (source-only) |
| DSH runtime target | 0.1.2-alpha.3 / `dd6322d…` | `sources.lock.json`, `compat/dsh-matrix.json` |
| DSH npm compile baseline | 0.1.2-alpha.3 (`alpha`) | pnpm catalog, compatibility matrix |
| Playwright Chromium | 1.59.1 / browser revision 1217 | root dev dependency and `test:browser` |
| Prototype PDF.js | 6.3.289 | apps/web/package.json and pnpm-lock; not a production renderer decision |
| Prototype Noto Sans SC | @fontsource-variable 5.3.0 | bundled local font assets; no external browser font requests |

The reviewed source target and npm compile baseline now match exactly. Compatibility still requires source probes,
an isolated package mount, browser checks, and a real mounted Web smoke; matching version strings alone are not evidence.

## Bootstrap

```bash
bash scripts/bootstrap.sh
bash scripts/check.sh
```

`scripts/pnpmw` uses an already-active Node 22.19.0 or downloads the matching official Node archive into ignored `.cache/tools`, verifies its fixed SHA-256, and invokes pnpm through Corepack. It never changes the user's global Node installation.

uv uses only its managed CPython 3.12.12. Python dependencies and tools are installed from `uv.lock`; do not run pip or Poetry in this workspace.

## Workspace boundaries

```text
contracts/                    Canonical language-neutral wire schemas
packages/contracts/           TypeScript bindings and contract helpers
plugins/docatlas-dsh/         The one installable DSH Host/Client package
python/docatlas-sidecar/      uv-managed document-process package
docs/                         Canonical implementation plan, ADRs, and runbooks
compat/                       Legacy DSH probes and source-reviewed Pi parity baseline
evals/                        Milestone-owned quality fixtures
research/                     Design evidence; not imported by runtime code
.sources/                     Ignored, pinned, read-only upstream checkouts
```

`package.json#dsh` and `plugins/docatlas-dsh/cordis.patch.yml` are the DSH plugin manifest. `dsh.plugin.json` belongs to some community distribution flows but is not consumed by the fixed DSH runtime and must not become a second manifest.

The executable `apps/web` prototype uses the existing React/Vite toolchain, PDF.js and an authenticated loopback static
preview. Use `bash scripts/pnpmw run demo` and `bash scripts/pnpmw run test:demo`; no model/Python service is called.
`packages/core` and `packages/runtime-pi` now enter workspace manifests/locks and CI for initial extraction/runtime work;
`apps/server` and `packages/reader` remain future implementations. Pi's upstream checkout uses npm and remains source-only;
product dependencies must use pinned pnpm. Do not import `.sources` into product builds.

## Dependency changes

JavaScript dependencies use pnpm:

```bash
bash scripts/pnpmw add --filter <workspace-package> <dependency>@<version>
```

Python dependencies use uv:

```bash
uv add --package docatlas-dsh-sidecar <dependency>==<version>
uv add --package docatlas-dsh-sidecar --dev <tool>==<version>
uv lock
```

Commit both lockfiles after successful checks. Do not mix package managers.

## DSH mount smoke

The optional networked smoke packs the final plugin tarball, creates an isolated temporary DSH home, installs it into the public compile baseline, and checks the composed profile:

```bash
bash scripts/pnpmw run smoke:dsh
```

Passing this smoke does not establish browser behavior; the Client component has a separate browser gate below.

The controlled Reader browser harness mounts the real Client component with deterministic authenticated RPC fixtures
and runs keyboard, responsive, Compare, selection, reduced-motion, and axe checks:

```bash
bash scripts/pnpmw run test:browser
```

Install the pinned Chromium build with `bash scripts/pnpmw exec playwright install chromium` when it is not already in
the Playwright cache. This browser gate complements, rather than replaces, the isolated DSH package mount above.
