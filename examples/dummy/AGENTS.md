# AGENTS.md

Postly. Multi-tenant team blog. Read `CLAUDE.md` for layout and conventions; read
`x.manifest.json` for facts (routes, actions, policies, jobs) — it is regenerated every build
and is always right. This file is hand-written and stays short.

## Before you start

```bash
bin/setup     # once
bin/dev       # dev server + MCP at ws://localhost:9229
```

Point your MCP client at the dev server. `routes.list`, `schema.describe`, `policies.list`,
`actions.list` answer faster and more correctly than grep.

## Before you finish

```bash
bin/check     # x verify — typecheck, lint, boundaries, six test types, budgets, SEO, i18n
```

Green means shippable. Nothing else is a gate.

## House rules an agent cannot infer

- Add a feature as a folder under `apps/web/app/<feature>/`, one file per job. Do not create a
  `lib/`, `utils/`, or `helpers/` directory — those names mean the code has no owner.
- Business logic that two apps need goes to `packages/core`, not into a shared route.
- Never write SQL outside a `repo.ts` or a generated migration.
- Never add a second way to do something that already has one way. Deleting the alternative is
  the fix, not documenting both.
- New user-facing string → add it to **both** `packages/i18n/catalogs/en.json` and `es.json`.
  A missing key fails `x verify`; an English fallback in the Spanish catalog is worse than a
  loud `⟦key⟧`.
- New timestamp on screen → `<DateTime zone={member.tz}>`. There is no other formatter.
- New price on screen → `<Money value={plan.price}>`. Never format money by hand.
- New action → set `mcp: { expose: true }` unless it must never be agent-callable, and say why
  in a comment if not.

## Where things intentionally look duplicated

- `publishPost` and `likePost` do similar-looking work. `publishPost` is an `action`
  (server-authoritative, no local twin); `likePost` is a `mutator` because likes must work
  offline. The primitive encodes the difference; do not merge them.
- `packages/db/src/schema/*.ts` declares entities, `apps/web/app/*/entity.ts` declares view
  schemas. Tables are shared across apps; views belong to one feature.

## Known sharp edges

- `x db gen` writes migrations from entity diffs. If it reports `X_DB_DRIFT`, the entity changed
  without a migration — run the `fix:` command it prints, never edit SQL.
- The digest job's per-member scheduling has DST tests in
  `packages/core/src/digest-schedule.test.ts`. If you change the scheduling, those tests are the
  spec.
