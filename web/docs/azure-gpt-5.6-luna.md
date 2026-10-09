# Azure GPT-5.6 Luna test route

> These are the existing DSH/native-DocAtlas test routes, retained as migration baselines. They do not certify the new
> Pi adapter. That adapter's Azure routing, token refresh and multimodal/tool behavior require the separate R1/R6 gate.

## Result

The project is connected to:

```text
https://libei-foundry-eastus2.openai.azure.com/openai/v1
```

using model/deployment `gpt-5.6-luna` and the Responses API. The official [GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) confirms the model ID, Responses support, text/image input, reasoning support, and context limits.

Validated on 2026-08-29:

- Azure Responses request with an Entra bearer token: HTTP 200.
- Azure v1 route without an `api-version` query: HTTP 200.
- Real DSH `headless` Agent Loop: returned `DSH_AZURE_LUNA_OK`.
- DSH filesystem tool loop: Luna read an unpredictable cache-file nonce and returned it exactly.
- DSH composed config: provider `azure-luna-entra`, model `gpt-5.6-luna`.
- Cache/log secret scan: no bearer token or credential environment name persisted.
- Native DocAtlas plugin + packaged sidecar single Loop: Search → locate → blocks → answer over a generated local PDF.
- Grounded result: `USD 15.2 million`, physical PDF page 2; 1 turn, 4 steps, 3 successful standard tool results.
- Live and cold-restored `docatlas.tools` projections matched; no custom DocAtlas Session event was emitted.

## Authentication

No API key is stored. `scripts/run-dsh-azure-luna.sh` asks the signed-in Azure CLI for a short-lived Cognitive Services access token and exposes it only to the DSH child process as `DOCATLAS_AZURE_OPENAI_BEARER_TOKEN`.

Prerequisites:

```bash
az login
az account show --output none
```

The current identity must have data-plane access to the Azure OpenAI resource. The launcher retrieves the token internally and never prints it.

## Run

```bash
bash scripts/test-dsh-azure-luna.sh
bash scripts/test-docatlas-azure-luna.sh
```

Run another headless task:

```bash
bash scripts/run-dsh-azure-luna.sh "Reply with one sentence describing your model tier."
```

The isolated DSH home defaults to `.cache/dsh-azure-luna`. Override it only when needed:

```bash
DOCATLAS_DSH_AZURE_HOME=/an/isolated/path \
  bash scripts/run-dsh-azure-luna.sh "Reply with exactly: ok"
```

## Why this is a custom route

The fixed DSH alpha source has a native `azure-openai-responses` catalog provider, including GPT-5.6 Luna, but that provider currently resolves `AZURE_OPENAI_API_KEY`. This environment has Entra data-plane access and no Azure subscription key. The test therefore uses DSH's custom `openai-responses` route so the OpenAI-compatible adapter sends the short-lived token as `Authorization: Bearer` to Azure `/openai/v1`.

The patch intentionally limits `maxTokens` to 4096 for tests; it does not claim that 4096 is the model's maximum capability. Telemetry is disabled and the sandbox is read-only in the launcher.

If a resource key is provisioned later, switch to the native `azure-openai-responses` route with `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_BASE_URL`; do not place the key in the patch or repository.

## Original DocAtlas backend

The pinned Microsoft implementation also works with this endpoint through its native `AzureCliCredential` fallback when configured with the repository default:

```text
AZURE_OPENAI_ENDPOINT=https://libei-foundry-eastus2.openai.azure.com/
AZURE_OPENAI_API_VERSION=2025-04-01-preview
AZURE_OPENAI_DEPLOYMENT=gpt-5.6-luna
```

That path returned `DOCATLAS_NATIVE_AZURE_OK`. Setting only `AZURE_OPENAI_API_VERSION=v1` does not migrate the original backend to Azure `/openai/v1`; the Azure SDK keeps its legacy URL construction and returns 404. The DSH route and original DocAtlas route therefore intentionally use different URL/API-version forms.

## Downstream DocAtlas checkout

The writable `DocAtlas-Harness/` checkout is configured locally through its
ignored, mode-`0600` `.env` with the same native Azure SDK route above. It does
not store an API key; both the main Responses backend and the Search/Review aux
client use `AzureCliCredential`.

Validated on 2026-08-30:

- main backend returned `DOCATLAS_LOCAL_AZURE_OK`;
- aux backend returned `DOCATLAS_AUX_AZURE_OK`;
- a real sample-document Agent Loop used `read(mode="locate")`, displayed three
  bounded TUI candidates, followed with `read(mode="blocks")`, and answered
  `Q4 revenue = USD 15.2 million` from physical PDF page 2;
- the run also exposed and fixed explicit schema default `figures: []` being
  mistaken for a visual request;
- non-zero Skill exits now preserve structured stdout errors instead of showing
  an empty stderr message.

Run the same local checkout with:

```bash
cd DocAtlas-Harness
az account show --output none
uv run --python 3.12.12 --locked docatlas tui
```
