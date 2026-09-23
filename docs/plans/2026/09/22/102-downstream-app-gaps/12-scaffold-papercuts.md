# 12 — Scaffold and generator papercuts

> Part of [`overview.md`](overview.md). Depends on: 01 (default-locale deletion), 11 (api route generator). Tier: 5.

Rule: what `x new` writes passes its own AGENTS.md rules. The gate catches every rule the scaffold
states. One fact has one source. Every sub-item below ships with a test that fails on today's
template.

## Files to change

| # | Item | File:line | Change | Enforced by |
|---|---|---|---|---|
| a | dotted app name | `packages/cli/src/cmd-new.ts:204-218,237` | Keep `raw` as the directory name when it matches `^[a-z0-9][a-z0-9.-]*$` (a domain), and use `kebab` only for package names and identifiers. Otherwise slug it and **say so**: a `cli.new.renamed` line `"<raw>" → "<kebab>/"` plus `data.renamedFrom` in `--json`. The `--force` existence check reads the final target, and the conflict fix line names it | `cmd-new.test.ts`: `x new shop.example --dry-run --json` gives `data.dir` ending `shop.example`; `x new "My Shop"` reports `renamedFrom` |
| b | untranslated seed | `packages/cli/src/i18n-audit.ts:188-190`, `cmd-i18n.ts:187-199` | `seedCatalog` writes `loudMiss(key)` (`i18n-registration.ts:188`) for every key instead of copying source values, exactly as `x i18n sync` does. `x i18n check` then lists them as missing via `withPlaceholdersMissing`. Add `x i18n add <loc> --default`, which rewrites `default:` in the app's `defineCatalogs` call, the single source after slice 01 | `cmd-i18n.test.ts`: after `add es`, `check` reports N missing, and `--default` flips `localeConfig().fallback` |
| c | route imports repo | `packages/cli/src/app-boundaries.ts:55-59,200-210` | A route file importing a specifier whose last segment is `repo` (`./repo`, `../post/repo`, `@app/x/repo`) is `X_BOUNDARY_ROUTE_TO_DB`, the same code since it is the same rule (AGENTS.md "Data" row). Fix line: `x g query <name>` | `app-boundaries.test.ts` case `../post/repo` |
| c2 | scaffold violates c | `packages/cli/src/templates/scaffold-dashboard-example.ts:39` | The dashboard `load` calls the generated `postList` query (`.as(actor, …)`), not `repo`. `scaffold-fixture.ts` compiles it | `bun run scripts/reference-app-gate.ts` and the scaffold `x verify` stay green with rule c on |
| d | three role lists | `templates/scaffold-domain-package.ts:26-28`, `templates/scaffold-auth.ts:43-48`, `templates/scaffold-roles.ts:30-40` | Delete the domain `ROLES`/`Role` (nothing reads them). `DEV_ROLES` becomes `Object.keys(roles)` imported from `shared/roles.ts`. `roles.ts` stays the one list | `scaffold-permissions.test.ts`: `grep`-style test that no other `as const` role tuple exists in the scaffold output |
| e | dev actor to real auth | `templates/scaffold-repo.ts:80-99`, `templates/scaffold-auth.ts:48` | Add `@ultimat3/auth` to scaffold deps. `DEFAULT_DEV_ROLE` becomes the **lowest** role (`member`), and `/admin` is opened by the cookie the warning prints. Add a generator `x g auth` (`generate-kinds.ts:14-28`) that writes `defineAuth` wiring, sign-in/up routes and `configureAuthenticator` resolving the session, and demotes `dev-actor.ts` to "no session cookie + development" | `generate-kinds.test.ts` row; a scaffold test: a request with no cookie is `member` |
| f | uid mismatch | `templates/scaffold-helm.ts:44-47` vs `templates/scaffold-container.ts:66-68` | Set `runAsUser`/`runAsGroup`/`fsGroup` to the `bun` user's ids in `oven/bun:1.4-alpine` (`scaffold-container.ts:38`). Confirm them with `docker run --rm oven/bun:1.4-alpine id bun`; 1000 is expected, but read it rather than assume. Mount an `emptyDir` at `/app/.x`, since `readOnlyRootFilesystem: true` (`scaffold-helm.ts:51`) makes the chowned dir unwritable anyway | `scaffold-container.test.ts`: parse both outputs and assert the uid in values equals `id -u` of the Dockerfile `USER`, from a table `{ bun: 1000 }` |
| g | `--feature` ignored | `templates/resource.ts:173-175`, `generate-files.ts:87-97` | `resourceFiles` uses `target.feature` for the slice dir (the entity name stays `rawName`) | `generate-files.test.ts`: `x g resource invoice --feature billing --dry-run` writes under `apps/web/app/billing/` |
| g2 | admin page dir | `templates/admin-page.ts:15` vs `templates/scaffold-app.ts:324` | Default `DEFAULT_ADMIN_PAGE_DIR` to the dir the scaffold actually writes (`apps/admin/app/admin/`), derived from one constant both files import | `admin-page.test.ts` |
| h | CI runner + publish | `templates/github/ci.yml.ts:64`; new `templates/github/publish.yml.ts` | `x new --runner <label>` (default `ubuntu-latest`) is written into `runs-on`. `x new --publish ghcr` adds `publish.yml`: on `main` push, build `docker/Dockerfile`, push tag `sha-<7>` plus the full sha, never `latest`. The tag contract is copied from `.github/workflows/deploy-social-demo.yml:7,56,75`, and the comment states it. Opt-in, so a scaffold that does not deploy by image carries no workflow | `ci.yml.test.ts`, `publish.yml.test.ts` (actionlint-shape checks already used for `ci.yml`) |
| i | guard skeleton | `templates/guard.ts:28-80` | Emit a neutral skeleton: one `files` loop, a `TODO`-free rule that reports nothing, plus a comment pointing at the NOT-NULL example in `wiki/` rather than inlining it under the new guard's code | `guard.test.ts`: generated guard returns `[]` on the scaffold and its `CODE` is `guardCode(name)` |

## Steps
1. Land a, c+c2, d and f first. These are the silent-wrong-state ones.
2. Then b (needs slice 01's single default), g and g2, i.
3. Then e (new generator) and h (new flags), each with docs in `wiki/CLI-Reference.md`.

## Tests
- `bun test packages/cli/src/cmd-new.test.ts packages/cli/src/cmd-i18n.test.ts packages/cli/src/app-boundaries.test.ts packages/cli/src/templates/`.
- `bun run scripts/reference-app-gate.ts`. The scaffold smoke (`x new` then `x verify`) must stay green, with rule c active.

## Done when
- A fresh `x new shop.example` lands in `shop.example/`.
- `x i18n add es --default` makes `es` the default and lists every key as missing.
- The scaffold has one role list, a uid that matches between Dockerfile and chart, and no route importing `repo`.
- `x g resource … --feature f` writes into `f/`.
