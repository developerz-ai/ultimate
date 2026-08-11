# apps/web

The app itself: the public site, the signed-in product, and the HTTP/OpenAPI/MCP surface. One
image; `ROLE` decides whether a process serves web, syncs realtime, runs jobs, schedules them, or
applies migrations and exits.

## Layout — surface first, then feature

| Directory | What lives here | Hard rule |
|---|---|---|
| `site/` | public, anonymous, SEO-critical pages | **0kb JS**, and it **may not import `app/`** |
| `app/` | signed-in pages and the feature slices behind them | may hydrate, may subscribe to a live query |
| `api/` | `defineApi(...)` — registration only | no rendering, no logic |
| `shared/` | design tokens, view types, the typed client | a **leaf**: both surfaces import it, it imports neither |

**The directory is the URL.** `app/posts/[id]/page.tsx` is `/posts/:id`. The filename never
contributes — `page.tsx` on `site/`/`app/`, `route.ts` on `api/`, and nothing else is a route.

A feature slice is one directory holding `entity.ts`, `policy.ts`, `actions.ts`, `mutator.ts`,
`live.ts`, `jobs.ts`, `service.ts`, `repo.ts`, `errors.ts` and `ui/`. Each file has one job, and
only `repo.ts` writes SQL. There is no `lib/`, `utils/` or `helpers/` — those names mean the code
has no owner.

## Registration is the import scan

`api/index.ts` hands whole modules to `defineApi`, so **the export name is the primitive's name**.
There is no second list of strings to keep in step, and no composition root to edit — which is why
adding a feature here touches the feature's own files and nothing else.

The consequence to know: one unresolvable import kills the scan, and every route after it silently
fails to register. A blanket 404 means a module failed to load, not that a route is missing.

## Commands

`x dev` · `x routes --json` · `x g route <path> --surface site|app` · `x g resource <name>` ·
`bunx x test unit|contract|live|job|e2e` · `bin/check`

## Boundaries, enforced

`site/` importing `app/`, a page importing the database, or `shared/` importing a surface are all
build errors, not review comments. Run `x verify`'s `boundaries` step to see them.
