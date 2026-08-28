# Contributing to DocAtlas

Thank you for helping improve DocAtlas. Please open an issue before a large
behavioral or public-API change so the design can be discussed first.

## Development setup

```bash
uv sync --locked --extra dev
uv run --locked pytest
uvx ruff==0.16.5 check .
uvx ruff==0.16.5 format --check .
uv run --locked --with mypy==2.3.1 mypy docatlas
uv build
```

The release dependency set is intentionally frozen. Do not change dependency
requirements or regenerate `uv.lock` in an unrelated pull request. Dependency
changes require a dedicated security and compatibility review.

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
