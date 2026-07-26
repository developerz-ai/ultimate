# @ultimat3/manifest — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `render mcp ai pwa ui admin testing cli`.

Route and policy facts come from tier 4 / per-app code, so they are **injected** by the CLI,
not imported.

## Owns

| File | Job |
|---|---|
| `schema.ts` | the manifest's typed shape + `MANIFEST_VERSION` |
| `build.ts` | `buildManifest` — pure, deterministic, stably sorted |
| `sources.ts` | wires `describe*` from entity/action/query/jobs into `ManifestSources` |
| `diff.ts` | `diffManifest` — breaking / additive / internal |
| `verify.ts` | `verifyContract` — the major-bump gate |
| `emit.ts` | canonical serialisation, write, `--json`, drift check |
| `agents-md.ts` | read-only AGENTS.md existence + size check |

## Invariants

- **No nondeterminism.** No timestamp, git sha, hostname, counter, or unsorted iteration.
  `buildManifest` is pure — it must never read a registry, a clock, or the filesystem.
- Top-level key order in the file is fixed by `KEY_ORDER` in `emit.ts`.
- `buildId` = sha256 of the canonical body. Verifiable from the file alone.
- Job `steps` keep declared order. Everything else sorts.
- `permissions` is derived, never a second declared list.
- `agents-md.ts` **never writes**. Generated prose lowers agent task success; facts go in
  `x.manifest.json` and conventions stay human-authored.
- A new manifest field ⇒ bump `MANIFEST_VERSION` and add a `diff.ts` rule for it.

## Commands

```
bun test packages/manifest
bun run --filter @ultimat3/manifest typecheck
x manifest        # build + emit
x verify          # drift + contract gate
```
