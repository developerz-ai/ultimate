# 13 — Docs, stale claims, Known-Gaps rows

> Part of [`overview.md`](overview.md). Depends on: each row lands with its slice; this slice sweeps what is left. Tier: docs.

Rule: a gap that is open when a slice merges gets a Known-Gaps row in the same PR. When the slice
closes it, the row moves to *Closed* with the release. Docs that promise an unmounted surface are
corrected on day one, before any code slice.

## Files to change
- `packages/http/README.md:284-310` — before slice 11 lands, add a warning line to the webhook example: "`api/**/route.ts` method exports are not mounted in 20.x; see Known-Gaps". Slice 05 rewrites the section.
- `docs/architecture/17-uploads.md:108-125` and `wiki/Known-Gaps.md:40` (`acceptSignedUpload` row) — both tell the reader to mount a `PUT` in `api/`. That is the same unmounted surface: point them at the new row below until slice 11 lands.
- `wiki/Tutorial-03-Auth-And-Admin.md:185-187` — **stale**. It says "nothing wires [AUTH_TABLES] into a migration … paste each statement". `FRAMEWORK_SCHEMA` applies them at every boot (`packages/cli/src/framework-schema.ts:30-94`). Rewrite it to say so, citing `x db migrate` and `ROLE=migrate`.
- `wiki/Jobs-And-Workflows.md` (and the `x jobs` section, `wiki/CLI-Reference.md:855`) — one paragraph: an app reads queue state with `jobDriver()` plus `inspectQueues()`/`inspectJob()` from `@ultimat3/jobs`. This closes the "no runtime accessor" question with the exported API.
- `wiki/Queries-And-Live-Queries.md:3`, `wiki/Actions.md:96`, `wiki/MCP-And-AI.md:120-126` — edited by slices 06, 05 and 07.
- `CHANGELOG.md` `[Unreleased]` — one `### Added` / `BREAKING —` / `### Fixed` entry per slice. Fixed: `Set-Cookie` merge, `defineAppMcp({ path })` ignored, scaffold uid, `--feature` ignored, route→repo import unguarded.
- `wiki/Upgrading.md` 21.0.0 — lines for:
  - `AppConfig.locales`/`defaultLocale` removed;
  - `ai.mcp.path` removed;
  - admin MCP tool renames;
  - `AuditRecord.action` → `name`.

## Proposed `wiki/Known-Gaps.md` rows
Do not edit Known-Gaps from this plan's first PR without the slice that owns the row. Each row
below is added **open** when the gap is confirmed on `main`, and moved to *Closed* by its slice.

| Section | Gap | Symptom | Work around it by | Closed by |
|---|---|---|---|---|
| Open | `api/**/route.ts` method exports are never mounted | the http README's `POST(request)` example and the uploads doc's `PUT` answer `X_ROUTE_NOT_FOUND` under `x dev` and in the container. `app-load.ts` imports the module and drops the export | none that reads headers: `RuntimeOverrides.middleware` wraps only *matched* route handlers (`packages/http/src/stages.ts:120-121`), and an unmatched path throws `X_ROUTE_NOT_FOUND` first (`:171-173`). For a sender that signs in-body fields, an action whose input takes the body (`text/*` arrives as a string, `request.ts:221`) | 05 + 11 |
| Open | Only one app MCP surface mounts, and `defineAppMcp({ path })` is ignored | the first `apps/*/mcp.ts` by sort order wins, at `config.ai.mcp.path`. An `apps/admin/mcp.ts` silently replaces the app's `/mcp` | keep one `mcp.ts`; serve a second catalog over `serveStdio` inside the cluster | 07 + 11 |
| Open | Multiple `Set-Cookie` from one request keep only the last | the response stage merges context headers with `set` (`packages/http/src/stages.ts:444`) | set at most one cookie per request through `useRequestContext().headers` | 05 |
| Open | `s3Driver.put` sends no checksum, metadata, SSE or Object Lock headers | `Bun.S3Client.write` takes only `type`. An Object Lock bucket may reject the PUT, and per-object retention is inexpressible | bucket default retention, plus a hand-signed PUT in app code | 03 |
| Open | A query cannot be audited | only `action({ audit: true })` reaches the sink | make the audited read an action | 06 |
| Open | The scaffold's Helm `runAsUser: 65532` does not match its Dockerfile `USER bun` | `/app/.x` is owned by `bun` and unwritable to the pod user | set `podSecurityContext.runAsUser` to the image's `bun` uid | 12 |
| Open | Scaffold route imports `repo` under a green gate | `apps/web/app/dashboard/page.tsx` imports `../post/repo`, and `X_BOUNDARY_ROUTE_TO_DB` matches only `db` specifiers | call the generated query from `load` | 12 |
| Open | `AppConfig.defaultLocale` is read by nothing | setting it changes nothing. The runtime default is `defineCatalogs({ default })` | set `default` in `packages/i18n/src/index.ts` | 01 |
| Not built yet | append-only tables | no entity option. The trigger is a hand migration plus a snapshot sidecar | hand migration, following `wiki/Migrations-And-Backfills.md:50` | 04 |
| Not built yet | human-confirmed MCP tools | no pending-call primitive | model the pending call as your own entity plus a non-exposed approve action | 07 |
| Not built yet | SES driver, retained MIME, delivery events | SMTP and Resend only | SMTP to SES's SMTP endpoint (MIME is then the framework's), with events parsed in app code | 08 |
| Not built yet | document and image blocks in `@ultimat3/ai` | text-only messages | extract text before the call | 09 |
| Open by decision | DB role grants for append-only tables | role names are deployment facts (axiom 7). The trigger holds for every role, owner included | grant DML minus UPDATE/DELETE to the runtime role in your own migration | — |

## Steps
1. Day one: the README warning, the uploads and Known-Gaps pointers, the tutorial fix, and the jobs paragraph. Docs only; `bun run verify` doc steps stay green.
2. Per slice, the owner adds and closes its row.

## Tests
- `bun run scripts/doc-config-keys.ts` (the config keys removed in 01 and 11 vanish from docs); the `X_DOC_*` gate steps; `bun run changelog-check`.

## Done when
- No doc promises a surface the tree does not mount.
- Every *Open* row above is either present with a workaround or already *Closed* with its release.
