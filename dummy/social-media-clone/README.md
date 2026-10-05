# SocialMediaClone

Built with [Ultimate](https://github.com/developerz-ai/ultimate). Bun-only, Postgres, SolidJS.

## 🚀 Start

```sh
bun run setup # prerequisites, deps, env, migrate, seed
bun run dev   # all roles in one process, embedded Postgres, /_x mounted
bun run check # the gate: a static build, then typecheck, lint, boundaries, tests, drift, budgets
```

## 🗺 Layout

| Path | Holds |
|---|---|
| `apps/web/site` | static/isr, 0kb JS, SEO-critical |
| `apps/web/app` | authed, streaming, realtime |
| `apps/web/api` | actions only |
| `apps/web/shared` | tokens, primitives, actor type — a leaf |
| `apps/admin` | generated admin dashboard: `app/admin` screens, `api` the one write door, `shared` its leaf |
| `packages/*` | domain, db, i18n, ui, mcp |
| `app.config.ts` | the one config file |
| `x.manifest.json` | generated facts: routes, actions, jobs, policies |
