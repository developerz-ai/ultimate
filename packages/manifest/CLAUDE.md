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
| `diff.ts` | `diffManifest` — the orchestrator: one classifier per section, nothing else |
| `diff-change.ts` | the shared vocabulary: `ManifestChange`, `index`, `diffNamedSet`, `diffScalar` |
| `diff-operations.ts` | actions, queries and the permissions they require |
| `diff-rate-limit.ts` | how a declared rate limit moved |
| `diff-entities.ts` | tables, columns, keys, invariants |
| `diff-work.ts` | jobs and tasks — the two things that fail by silently not happening |
| `diff-routes.ts` | a URL's surface and its delivery facts |
| `diff-registries.ts` | policies and error codes |
| `diff-fixtures.ts` | TEST-ONLY: one fully-populated `ManifestSources`. Never in `index.ts` |
| `verify.ts` | `verifyContract` — the major-bump gate |
| `emit.ts` | canonical serialisation, write, `--json`, drift check |
| `agents-md.ts` | read-only AGENTS.md existence + size check |
| `docs-scan.ts` | read-only: an installed package tree → `DocEntry[]`. Never writes |
| `docs-search.ts` | pure ranking of `DocEntry[]` against a question. No I/O, no clock |

## Invariants

- **No nondeterminism.** No timestamp, git sha, hostname, counter, or unsorted iteration.
  `buildManifest` is pure — it must never read a registry, a clock, or the filesystem.
- Top-level key order in the file is fixed by `KEY_ORDER` in `emit.ts`.
- `buildId` = sha256 of `@ultimat3/core`'s `canonicalJson` over the body — the framework's one
  INJECTIVE form, and the same one every `diff-*.ts` equality is taken over. It was a local
  `JSON.stringify(sortKeys(v))` until 2026-08-22, exported from `index.ts` as `canonical`
  (**removed, breaking**): that form spells `-0` as `0` and `NaN`/`±Infinity` as `null`, so a
  default a client is told to expect could move and the diff answered "no change". Ordinary JSON
  is byte-identical between the two — both tracked apps' committed manifests hash to the same id
  they already carried — so the swap is observable only where the old form folded. **The published
  document is `manifestJson` and is still `JSON.stringify` with a fixed key order**: an injective
  form emits tokens JSON cannot parse, which is why `@ultimat3/action`'s `stableStringify` exists
  as a separate function and why this one may not be written to disk.
- Job `steps` keep declared order. Everything else sorts.
- `permissions` is derived, never a second declared list — and derived from each operation's own
  `permissions`, **never from `policy`**. `policy` is a DISPLAY label: a composite renders as
  `and(post:publish, org:administer)`, which is not a permission and matches no grant, so deriving
  from it published one fictional entry per composite rule and dropped every real one.
- **An operation's own `permissions` and `rateLimit` are contract, and `diff.ts` classifies both.**
  A permission gained is breaking (every caller holding the old grant set starts collecting 403s
  and no schema in the file moved); one dropped is additive but reported, because a widening of
  access is what a reviewer most needs to see. A rate limit tightened — in burst OR in refill rate,
  compared cross-multiplied so no rounding can invent a change — is breaking, and so is
  introducing one where there was none; loosening or removing is additive.
- **An absent `permissions` is NOT an empty one.** Unlike `mcp.expose` there is no value to fold
  absence into: `[]` asserts "this operation requires nothing", so reading an absent field that
  way would call every permission of every operation newly required the first time an app diffs
  against a manifest written before the field existed. Absence is no evidence — the comparison is
  skipped. Same for a `rateLimit` neither half of which `toBucket` would accept.
- **`isManifest` checks every top-level key, never five and a cast.** `diffManifest` reads
  `before.queries`, `before.jobs`, `before.permissions` and `before.locales` with no guard, so a
  section a truncated or hand-trimmed file happens not to carry was a bare `TypeError` two calls
  from the gate that exists to explain. The FACTS inside a section stay unwalked — a manifest
  written before a field existed is still readable, which is `MANIFEST_VERSION`'s rule.
- **A byte count is `Buffer.byteLength`, never `String.length`.** `EmitResult.bytes` measures the
  file on disk and a manifest carries the APP's strings — a locale name, an entity description, a
  title in the app's own language — so UTF-16 code units under-report every non-ASCII one.
  `agents-md.ts` measures the same quantity the same way. Nothing committed carries the number:
  `writeAppManifest` is the only caller and it reads `path` alone, so correcting it is not drift.
- **`--json` is awaited.** `emitManifest({ stdout: true })` writes through `await Bun.write(
  Bun.stdout, …)`: a write to a pipe is asynchronous and `process.exit()` discards the queue, and
  this is the largest payload the CLI prints. Same bug `scripts/stdout-truncation.test.ts` pins.
- **One package's tree costs that package.** `scanInstalledDocs` guards each `scanPackageDocs`,
  and a `package.json` that will not parse is "not a package", not a `SyntaxError` thrown through
  the `Promise.all` for every other package to inherit. `node_modules` is not curated and is not
  stable while an install is running.
- `agents-md.ts` **never writes**. Generated prose lowers agent task success; facts go in
  `x.manifest.json` and conventions stay human-authored.
- `docs-scan.ts` emits **no artifact**. The published tarball is the source, so the docs are
  already installed; a generated `docs.json` would be a second copy of them, and the second copy
  is what drifts. There is no drift check for local docs because there is nothing that can drift.
- `docs-scan.ts` indexes the **file header comment**, not JSDoc: `As of 2026-08`, 99.8% of source
  files carry a header, 42.3% of public exports carry JSDoc, and `job()` is in the missing 57.7%.
- A guide topic is unique within its package — repeated headings take a document-order suffix.
- Neither docs module may import a registry or a clock. `docs-search.ts` is pure; `docs-scan.ts`
  reads files and nothing else.
- **A new manifest field ⇒ a `diff-*.ts` rule for it.** Always — a field nothing classifies is a
  fact the gate cannot see, which is the whole reason the field was added. Now enforced rather
  than stated: `diff.test.ts` walks `ARRAY_SECTIONS` (exported by `schema.ts`, the same list
  `isManifest` checks) and fails on a section emptying without a classified change. `tasks` and
  `errorCodes` were unread until 2026-08, along with ten fields — a renamed table, a dropped
  `primaryKey`/`references`, emptied `invariants`, a moved job `queue`, `retry.attempts` 5 → 0, a
  route's `surface`/`offline`/`hydrate`, and a query's `cacheTags` — and every one of them
  reported exactly `[{ kind: 'internal', path: 'buildId' }]` with `hasBreaking: false`. A new
  SECTION needs its own file beside the others; a new FIELD joins the file its section owns.
- **The axis is what a change refuses, not how it reads.** Something that rejects input that was
  valid yesterday is breaking (an invariant added, a NOT NULL, a gained permission, a gained
  enforcement site, a lowered `retry.attempts`); something that accepts more is additive and
  still reported (an invariant dropped, a permission dropped, more attempts). A removal is
  breaking on every section, including the two that fail silently: a deleted task never runs
  again and a job whose `queue` moved piles up where no worker is subscribed.
- **Absence is evidence only where absence has a meaning.** `primaryKey`/`references` absent IS
  "no key", so a dropped one is classified. `surface`, `offline`, `hydrate`, `budget` and
  `revalidateTags` absent means "this file predates the field", so `diffScalar` skips a side that
  carries nothing rather than reporting every route in an upgraded app as re-surfaced.
- **`MANIFEST_VERSION` bumps only when a reader built for the old version would be WRONG** — a
  field removed, retyped, or given a new meaning — never for one that is merely added. Two costs
  make the reflex expensive: `isCompatible` is an equality check, so a bump rejects every
  `x.manifest.json` in existence at once; and `diff.ts` classifies a `manifestVersion` change as
  **breaking**, so it also demands a major release of every APP that regenerates. Charging every
  app a major for a field their readers never had to look at is a fix line that is not true.
  `build.test.ts`'s `shape compatibility` case is the assertion — if it fails, the bump is earned.
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
