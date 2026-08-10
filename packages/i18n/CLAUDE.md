# @ultimat3/i18n — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. Nothing else, no external deps.
Imported by every package that renders a string.

## Boundary

| File | Single responsibility |
|---|---|
| `translator.ts` | lookup + delegate interpolation, and `TranslationKey`. No locale logic. |
| `catalog.ts` | nested → flat, merge, validate. No lookup. |
| `define-catalogs.ts` | the app's one registration call. Boot only, composes the four below. |
| `interpolate.ts` | `{var}` + CLDR plural selection. No catalog access (takes a `has` predicate). |
| `locales.ts` | supported set, normalize, negotiate, RTL. No catalogs. |
| `context.ts` | request locale via ALS, the registry, the ambient `t` and `useI18n`. |
| `extract.ts` | static scan + audit for `x verify`. |
| `catalogs/en.json` | data, not code. |

## Rules

- An app registers catalogs with `defineCatalogs({ default, locales })`. One call, at boot.
  `registerCatalog` / `configureLocales` are its internals — an app calling them is a second path.
- Reading: `t('ns.key')` for one string, `useI18n<AppCatalog>()` where the keys must be typed.
  There is no `currentTranslator`; `useI18n` replaced it.
- A miss renders `⟦key⟧`. Never add a fallback locale chain — it hides gaps.
- Plural selection is `Intl.PluralRules`. Never `count === 1`. Variants are underscore suffixes on
  the leaf — a CLDR category (`_zero _one _two _few _many _other`), or `n` / `n_plural` as the
  two-form shortcut; pair `n_one` with `n_other`, never with `n_plural`. Never a nested
  `{ one, other }` branch — the runtime probes the variant leaf (`n_other`), and `TranslationKey`
  admits the stem `n` on exactly that basis.
- `Translator<TCatalog = Catalog>` must keep defaulting to `string` keys: `@ultimat3/ui` and
  `@ultimat3/mail` take a bare `Translator`. `has()` and `raw()` stay `string` — they are probes.
- Nothing here formats a number, date or money. That is `@ultimat3/money` / `@ultimat3/time`.
- `Ctx` fields are read structurally (core cannot depend on `Locale`); one cast, in `context.ts`.
- Adding a framework string: `catalogs/en.json`, feature-namespaced, then use `t('ns.key')`.

## Commands

```
bun test packages/i18n
bun run --filter @ultimat3/i18n typecheck
```
