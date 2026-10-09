# Independent Web secret-scan baseline

The official root CI continues scanning every tracked file, including `web/`,
with detect-secrets 1.5.0 and its existing detectors. It does not exclude the Web
application, disable entropy detection, or ignore arbitrary credential fields.
The original vendor and binary-file exclusions are retained.

`.secrets.baseline` records exact, reviewed file/finding hashes, not a blanket
file allowlist. Its initial Web findings are source/patch/PDF checksums, npm
integrity values, and synthetic security-test canaries. The small non-entropy
set consists of deliberately invalid test credentials/URLs, private-data leak
sentinels, the synthetic encrypted-PDF password, and the noncredential
`secretScan: 'passed'` contract field. No original CLI finding is suppressed.
The baseline stores hashed findings only, never a credential value.

The standard hook rejects new findings even in files already in the baseline.
CI additionally requires every baseline finding to have been explicitly marked
`is_secret: false`; an unaudited scan refresh is not acceptable. New hashes are
not automatically safe: review their source, context and exact bytes before
updating the baseline. Never refresh a baseline to conceal a real credential;
remove/revoke that credential through the appropriate process instead.

From the repository root after staging the intended review scope:

```sh
git ls-files -z | xargs -0 uvx --from detect-secrets==1.5.0 detect-secrets-hook --baseline .secrets.baseline
```

Verification includes a synthetic, previously unlisted canary: it must fail the
hook. This confirms the baseline does not turn the entire migrated tree into an
unscanned area. The migration tracker records the final scan and negative test.
