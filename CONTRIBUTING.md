# Contributing to DocAtlas

Thank you for helping improve DocAtlas. Please open an issue before a large
behavioral or public-API change so the design can be discussed first.

## Development setup

```bash
uv sync --locked --extra dev
uv run --locked pytest
uvx ruff==0.16.5 check --extend-exclude web .
uvx ruff==0.16.5 format --check --extend-exclude web .
uv run --locked --with mypy==2.3.1 mypy docatlas
uv build
```

The release dependency set is intentionally frozen. Do not change dependency
requirements or regenerate `uv.lock` in an unrelated pull request. Dependency
changes require a dedicated security and compatibility review.

Run an offline sample comparison before and after dependency updates:

```bash
uv run --locked python scripts/benchmark_cli.py --output /tmp/docatlas-cli-sample.json
# Optional real Docling conversion, using cached weights only (CPU, OCR off):
uv run --locked python scripts/benchmark_cli.py --output /tmp/docatlas-cli-docling.json --docling
```

Use a fresh output filename for every run. Compare the input/output hashes before
the timings; a different paragraph grouping or crop is not an equivalent result.
The benchmark uses only the two public fictional reports. It does not establish
real-corpus, OCR, GPU, model-call or paper-benchmark equivalence. The reviewed
[CLI security candidate](web/docs/review/original-cli-security-maintenance.md)
records the current Docling output differences; these need explicit acceptance
before merging that dependency change. The independent Web has its own check
entry in `web/scripts/check.sh` and is not included in the root Python lint scope.

## Pull requests

- Keep changes focused and include tests for changed behavior.
- Preserve the JSON-over-stdio Skill contract.
- Run the Agent Skills validator when editing a Skill:

  ```bash
  uvx --from skills-ref==0.1.1 agentskills validate docatlas/skills/<skill>
  ```

- Update user-facing documentation when flags, outputs, or defaults change.
- Do not commit credentials, private documents, model outputs, or session data.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
