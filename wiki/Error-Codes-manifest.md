# Error codes: `@ultimat3/manifest`

Part of [Error codes](Error-Codes): every code `@ultimat3/manifest` registers. `x errors explain <CODE> --json` prints the same row.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_AGENTS_MD_MISSING` | no `AGENTS.md` | the human-authored file was deleted | write it by hand — short: stack, commands, conventions |
| `X_AGENTS_MD_TOO_LARGE` | `AGENTS.md` grew past its cap | generated facts pasted into it | move facts into `x.manifest.json`; keep conventions only |
| `X_MANIFEST_BREAKING` | a published contract was removed or narrowed | a breaking change with no version bump | bump the major version, or restore the contract |
| `X_MANIFEST_DRIFT` | a committed manifest differs from the code | a primitive changed without regenerating, or the file was hand-edited so its `buildId` no longer hashes its own contents | `x manifest` — `bun run manifest` for this repo's own `framework.manifest.json` |
| `X_MANIFEST_FACT_INVALID` | a manifest fact is a number JSON cannot write back | a declaration handed the manifest NaN, Infinity or -0 (a route budget, a rate limit, a retry count); JSON writes it as null or 0, so the committed file could never match its own buildId and every build read as drift | `set the declaration behind meta.path to 0 when meta.value is -0, otherwise to a finite number, then run x manifest` |
