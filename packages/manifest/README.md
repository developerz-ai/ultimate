# @ultimat3/manifest 📋

Generated facts. `x.manifest.json` is emitted from code, committed, and diffed in review —
it is how an agent learns what the app *is* without reading every file.

```ts
import { buildManifest, emitManifest, assertNoDrift, verifyContract } from '@ultimat3/manifest';

const manifest = buildManifest(frameworkSources({ app, routes, policies }));
await emitManifest({ manifest });                  // x manifest
await assertNoDrift({ manifest });                 // x verify
verifyContract({ before: committed, after: manifest });
```

## What it contains

| Section | Facts |
|---|---|
| `routes` | url, render mode, offline strategy, hydrate, revalidate tags, budget |
| `entities` | table, columns (type, nullability, PK, FK), named invariants |
| `actions` | input + output schema, policy, cache invalidations, MCP exposure, `mutator` when it is one |
| `queries` | input schema, policy, live, cache tags |
| `jobs` | input schema, queue, retry policy, step names |
| `tasks` | cron, tz, jobs enqueued |
| `policies` | permission, where enforced |
| `permissions` | **derived** from policies + primitives, never declared twice |
| `locales`, `errorCodes` | catalogs a tool can enumerate |

Plus `manifestVersion` (shape version, so a reader can check compatibility), `app`, and
`buildId`.

## Determinism

The file is committed and reviewed, so two builds of the same tree must produce identical
bytes. Enforced, not hoped for:

- **No timestamps, no git sha, no hostname, no build counter.**
- Every collection is sorted by a stable key before writing — `Map`/`Set` iteration order is
  insertion order, and insertion order depends on module load order, which depends on the
  filesystem.
- Object keys are written in a fixed order, not `JSON.stringify` order, so reordering a
  struct literal produces no diff.
- `buildId` is a sha256 of the canonical body, so it changes if and only if a fact changed —
  and `verifyBuildId()` re-derives it from the file, catching a hand edit.
- Job `steps` keep declared order. A job's steps are a sequence, not a set.

A manifest that churns on every build trains reviewers to ignore its diff, which defeats the
whole mechanism.

## The contract diff

`diffManifest(before, after)` classifies every change:

| Class | Examples |
|---|---|
| **breaking** | action/query/route/job/entity removed; input or output schema changed; policy changed; MCP exposure withdrawn; column removed, retyped, or made NOT NULL; live query became non-live |
| **additive** | primitive added; nullable column added; MCP exposure granted; locale added |
| **internal** | cache tags changed; render mode changed; job steps reordered; `buildId` |

`verifyContract()` is the gate: a breaking change fails unless the app's **major** version
moved. An unparseable version counts as "not bumped" — fail-closed.

```
X_MANIFEST_BREAKING: contract broke without a version bump
  cause: 1 breaking change(s) from 1.4.2 to 1.5.0 with no major version bump:
         actions.publishPost: action removed
  fix:   bump the major version in app.config.ts, or restore the removed contract
```

## AGENTS.md: validated, never generated

`checkAgentsMd()` / `assertAgentsMd()` verify that a **hand-written** `AGENTS.md` exists and
is under 12kB. They do not generate prose, and there is deliberately no generator to point at.

Research shows LLM-generated context files *reduce* task success and add steps: the prose
reads plausibly, drifts from reality the moment anything changes, and an agent trusts it over
the code. So the split is fixed:

- **facts are generated** → `x.manifest.json`, regenerated every build;
- **conventions are human-authored** → `AGENTS.md`, short enough to be read every time.

The checker warns (never fails) when `AGENTS.md` starts tabulating schema or route facts, runs
past 200 lines, or claims to be generated. Those warnings ride in the step's `output`, so
`x verify --json` carries them for a human to judge.

`x verify` runs `assertAgentsMd()` inside its `manifest` step — the same step that checks the
generated half — and unlike the drift check it applies everywhere, including a repo that has
never run `x manifest`. Enforced, not documented: both codes below can actually fail a build.

## Local docs: read, never emitted

`scanPackageDocs()` / `scanInstalledDocs()` read an installed package tree and return `DocEntry`
values; `searchDocs()` ranks them against a question. This is what `x docs "how does job() retry"`
answers from — offline, from `node_modules`, with no filename known in advance.

There is **no generated `docs.json`**, on purpose. The published artifact *is* the source
(`PUBLISHING.md`): `files` ships `src/**`, `README.md` and `CLAUDE.md`, and Bun runs the
TypeScript directly. Every doc is therefore already inside the tarball — what was missing was
retrieval, not payload. A per-package `docs.json` would be a **second copy** of bytes the install
already has, and the second copy is the one that goes stale. Reading the installed source cannot
disagree with the installed version, because it *is* the installed version.

| Entry | Source | Topic |
|---|---|---|
| `module` | the file header comment on a module `src/index.ts` re-exports, plus its public symbols | `jobs.retry` |
| `guide` | a `##` section of `README.md` or `CLAUDE.md`, quoted verbatim | `money.README#why-no-floats` |

The **file header** is the doc unit, not JSDoc: measured across this repo, 99.8% of source files
carry a 1–4 line header (2,510 of 2,514) while only 42% of public exports have JSDoc directly
above the declaration — `job()` itself has none. Ranking a question against 42% coverage would
have missed the framework's most-used export.

Same split as `AGENTS.md` above: this module **derives** facts and **quotes** human prose. It
never writes, and it never synthesises a sentence.

## Errors

| Code | Meaning | Fix |
|---|---|---|
| `X_MANIFEST_DRIFT` | committed file no longer matches the code, or was hand-edited so its `buildId` no longer hashes its own body | `x manifest` |
| `X_MANIFEST_BREAKING` | contract broke with no major bump | bump the version, or restore |
| `X_AGENTS_MD_MISSING` | no `AGENTS.md` | write one by hand |
| `X_AGENTS_MD_TOO_LARGE` | over the byte budget | move facts to `x.manifest.json` |
