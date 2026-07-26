# @ultimat3/i18n — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. Nothing else, no external deps.
Imported by every package that renders a string.

## Boundary

| File | Single responsibility |
|---|---|
| `translator.ts` | lookup + delegate interpolation. No locale logic. |
| `catalog.ts` | nested → flat, merge, validate. No lookup. |
| `interpolate.ts` | `{var}` + CLDR plural selection. No catalog access (takes a `has` predicate). |
| `locales.ts` | supported set, normalize, negotiate, RTL. No catalogs. |
| `context.ts` | request locale via ALS + the ambient `t`. |
| `extract.ts` | static scan + audit for `x verify`. |
| `catalogs/en.json` | data, not code. |

## Rules

- A miss renders `⟦key⟧`. Never add a fallback locale chain — it hides gaps.
- Plural selection is `Intl.PluralRules`. Never `count === 1`.
- Nothing here formats a number, date or money. That is `@ultimat3/money` / `@ultimat3/time`.
- `Ctx` fields are read structurally (core cannot depend on `Locale`); one cast, in `context.ts`.
- Adding a framework string: `catalogs/en.json`, feature-namespaced, then use `t('ns.key')`.

## Commands

```
bun test packages/i18n
bun run --filter @ultimat3/i18n typecheck
```
