# Official public fixtures: not fetched yet

`scripts/fetch_eta_refs.py` downloads four public files from
`https://sdk.invoicing.eta.gov.eg/files/` into this folder and writes
`manifest.json` with each file's source URL and SHA-256.

On 2026-10-17 the environment that built the integration could not reach that
host: its network policy refused `sdk.invoicing.eta.gov.eg` and the web
archive. So this folder holds no official files, and the tests that compare the
serialiser with them are **skipped**, not passed.

To fetch them, on a machine with normal internet access, from the repository root:

```bash
python3 scripts/fetch_eta_refs.py
```

Then read the four files, commit them with `manifest.json`, delete this file,
and run `pnpm --filter @integr8/eta test`: the official-fixture tests run
whenever `manifest.json` is present. The legacy sample is
`documentTypeVersion` 0.9; it is a serialisation fixture, not a v1.0 document.
