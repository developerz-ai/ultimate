# @ultimat3/manifest — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `render mcp ai pwa ui admin testing cli`.

Route, policy, task and locale facts come from tier 4 / per-app code, so they are **injected**
by the CLI, not imported.

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
| `docs-scan.ts` | read-only: an installed package tree → `DocEntry[]`. Never writes |
| `docs-search.ts` | pure ranking of `DocEntry[]` against a question. No I/O, no clock |

## Invariants

- **No nondeterminism.** No timestamp, git sha, hostname, counter, or unsorted iteration.
  `buildManifest` is pure — it must never read a registry, a clock, or the filesystem.
- Top-level key order in the file is fixed by `KEY_ORDER` in `emit.ts`.
- `buildId` = sha256 of the canonical body. Verifiable from the file alone.
- Job `steps` keep declared order. Everything else sorts.
- `permissions` is derived, never a second declared list.
- `agents-md.ts` **never writes**. Generated prose lowers agent task success; facts go in
  `x.manifest.json` and conventions stay human-authored.
- `docs-scan.ts` emits **no artifact**. The published tarball is the source, so the docs are
  already installed; a generated `docs.json` would be a second copy of them, and the second copy
  is what drifts. There is no drift check for local docs because there is nothing that can drift.
- `docs-scan.ts` indexes the **file header comment**, not JSDoc: 99.8% of source files carry a
  header, 42% of public exports carry JSDoc, and `job()` is in the missing 58%.
- Neither docs module may import a registry or a clock. `docs-search.ts` is pure; `docs-scan.ts`
  reads files and nothing else.
- A new manifest field ⇒ bump `MANIFEST_VERSION` and add a `diff.ts` rule for it.
- `diff.ts` reads `mcp.expose` through `isMcpExposed` from `@ultimat3/core`, on **both** sides.
  `before` is a file parsed off disk, so an older or hand-trimmed manifest can carry an absent or
  non-boolean value that `!==` would classify from; and the fact `sources.ts` publishes has to be
  the answer `toMcpTools` gives, or the gate demands a major bump for a tool that never existed.

## Commands

```
bun test packages/manifest
bun run --filter @ultimat3/manifest typecheck
x manifest        # build + emit
x verify          # drift + contract gate, and the AGENTS.md check under the `manifest` step
```
