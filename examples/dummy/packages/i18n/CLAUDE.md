# @postly/i18n

`en` + `es` catalogs and the typed `useT()` wrapper. No app logic.

## Boundary

| May import | Must never |
|---|---|
| `@ultimat3/i18n` | `@postly/db`, `@postly/core`, any app, the DOM |

## Files

| File | Owns |
|---|---|
| `catalogs/en.json` | the source of truth for keys — types are derived from it |
| `catalogs/es.json` | the same key set, translated |
| `src/index.ts` | `catalogs`, `useT`, `type AppCatalog`, `type TranslationKey` |
| `src/catalog.test.ts` | parity + no-empty-values + plural-shape checks |

## Commands

| Task | Command |
|---|---|
| test | `bun test packages/i18n` |
| find unused keys | `x i18n prune --json` (reports; never deletes) |
| find missing keys | `x verify` (fails) or `x i18n check --json` |

## Conventions

- Namespace by feature: `site.*`, `app.*`, `posts.*`, `orgs.*`, `plans.*`, `digest.*`, `errors.*`.
- Plurals are underscore suffixes on the leaf — `likes_one`, `likes_other` — never a nested
  `{ one, other }` branch, which the runtime never probes. Call sites pass `t('app.post.likes',
  { count })` and never branch themselves.
- Interpolation slots are `{name}` and are typed — a missing slot fails typecheck.

## Gotchas

- Adding a key to `en.json` only will typecheck and then fail `x verify`. Add both.
- `digest.*` is rendered in the `worker` role; keep it DOM-free and formatting-free.
