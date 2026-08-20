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
| `context.ts` | request locale via ALS, the registry + the base layer under it, the ambient `t` and `useI18n`. |
| `framework.ts` | the framework's own strings, installed as the base layer at module scope. |
| `registration.ts` | are the catalogs an app SHIPS in the registry it READS? No file access. |
| `extract.ts` | static scan + audit for `x verify`. |
| `catalogs/en.json` | data, not code. |

## Rules

- An app registers catalogs with `defineCatalogs({ default, locales })`. One call, at boot.
  `registerCatalog` / `configureLocales` are its internals — an app calling them is a second path.
- Reading: `t('ns.key')` for one string, `useI18n<AppCatalog>()` where the keys must be typed.
  There is no `currentTranslator`; `useI18n` replaced it.
- **`configureLocales` is process-global and MERGES, so `resetLocaleConfig()` is the only way back.**
  `defineCatalogs()` calls it at an app's module scope; a module evaluates once per `bun test` process,
  so one file that loads an app narrowed `supported` for every file after it and `Accept-Language: de-DE`
  negotiated `en` in a file that never mentioned locales. No partial call can widen the set back. The
  test harness restores it at each file boundary (`@ultimat3/testing`'s `registry-snapshot.ts`).
- A miss renders `⟦key⟧`. Never add a fallback locale chain — it hides gaps.
- **`FRAMEWORK_CATALOG` is the base layer**, installed by `framework.ts` at module scope —
  importing `@ultimat3/i18n` is what registers it, so no app can forget it and `resetCatalogs()`
  puts it back. It was `registerFrameworkCatalog()`, whose ONE caller was `defineCatalogs`, so an
  app whose catalog module nothing imported served `⟦errors.notFound.title⟧` on its 404 page and
  `⟦ui.*⟧` in every design-system control, with `x verify` green (issue #249). Under
  `FRAMEWORK_CATALOG_LOCALE` (`en`) **only**: it ran per locale until 2026-08, so an `es`-only app
  served `Page not found` with `isMiss` reading FALSE — the fallback chain the line above refuses,
  wearing registration as a disguise. A non-`en` app translates the framework keys it renders into
  its own catalog.
- **The base layer merges UNDER whatever `registerCatalog` seated, never over it**, so an app's
  override of a framework key survives every later install and the install is idempotent by
  construction rather than by a module flag `resetCatalogs()` would go stale against.
  `registerBaseCatalog` is **framework packages only** — `@ultimat3/mail` calls it for `mail.*`,
  which had the identical defect and the identical fix. It is not a second app path: everything
  installed there loses to `registerCatalog` on the same key, so the strongest thing an app could
  achieve by calling it is strings its own `defineCatalogs()` overrides. That the rule is
  documented and not a build error is the one hole in this file; closing it is a `boundaries` rule
  refusing the specifier outside `packages/*/src`.
- **A catalog on disk is not a registered catalog.** `catalogRegistrationGaps` /
  `assertCatalogsRegistered` answer the runtime question per locale — `X_CATALOG_UNREGISTERED` —
  and `x verify`'s `i18n` step is what asks it of an app. An app reads strings through its OWN
  module (`useT()` from `packages/i18n/src/index.ts`), never `t` from `@ultimat3/i18n`, so that
  registration is a consequence of rendering rather than something a boot has to remember.
- Only an **own** property of `vars` is a variable — `interpolate` guards with `Object.hasOwn`.
  A plain object inherits `constructor`, `toString`, `valueOf` and `__proto__`, so a bare
  `vars[name]` rendered a function's source into the page for a template nobody wrote a variable
  for. Same reach `catalog.ts` shuts off by nesting into null-prototype nodes; never reintroduce
  either. The `interpolate` fast path must test **both** braces: `}}` un-escapes with no `{` in
  sight, and a `{`-only check gave one escape two meanings.
- **A catalog is read through `Object.hasOwn`, never a raw index, and every catalog this package
  builds is `Object.create(null)`** — `flattenCatalog`, `mergeCatalogs` and `nestCatalog` all are.
  On a `{}` catalog `catalog['valueOf']` resolved to the INHERITED function, so `t('valueOf')`
  threw inside `interpolate`, `t('constructor')` returned a function through a signature typed
  `string`, and `isMiss(t('__proto__'))` threw on an object — all three reachable wherever a key
  travels as data (`t(row.labelKey)`). Both halves are load-bearing: the guard in `translator.ts`
  makes it true of a catalog this package did not build, the null prototype makes `__proto__` an
  ordinary key instead of one the setter silently swallows. Never reintroduce either.
- Plural selection is `Intl.PluralRules`. Never `count === 1`. Variants are underscore suffixes on
  the leaf — a CLDR category (`_zero _one _two _few _many _other`), or `n` / `n_plural` as the
  two-form shortcut; pair `n_one` with `n_other`, never with `n_plural`. Never a nested
  `{ one, other }` branch — the runtime probes the variant leaf (`n_other`), and `TranslationKey`
  admits the stem `n` on exactly that basis.
- `Translator<TCatalog = Catalog>` must keep defaulting to `string` keys: `@ultimat3/ui` and
  `@ultimat3/mail` take a bare `Translator`. `has()` and `raw()` stay `string` — they are probes.
- Nothing here formats a number, date or money. That is `@ultimat3/money` / `@ultimat3/time`.
- **The ambient locale IS `Ctx.locale`**, core's own declared field — this package writes no context
  field of its own and publishes no writer. `createContext({ locale })` and
  `withChildContext({ locale })` are the only ways in, `currentLocale()` the only way out.
  `attachLocale`/`localeOf` existed until 1.3.0 with zero callers; `@ultimat3/time` had the same
  pair over a field name (`ctx['timeZone']`) that disagreed with core's `tz`, which is what made
  every server-rendered date UTC. Never reintroduce either half.
- Adding a framework string: `catalogs/en.json`, feature-namespaced, then use `t('ns.key')`.
- **`catalogs/en.json` is gated in both directions**, on `x verify`'s `boundaries` step via
  `scripts/i18n-catalog.ts`. A `t('literal')` in `packages/*/src` with no entry is
  `X_CATALOG_MISSING_KEYS`; an entry nothing in framework source names, in a namespace the
  framework already renders (`admin.*`, `dev.*`, `ui.*`), is `X_CATALOG_KEY_UNREACHABLE`. The
  namespaces the framework only *ships* for an app (`common.*`, `auth.*`, `errors.*`,
  `pagination.*`, `validation.*`, `time.*`) are exempt from the second half and derived, not
  listed. `ui.*` is pinned exactly by `packages/ui/src/i18n-keys.test.ts`, because every ui string
  resolves as `ui.t(UI_KEYS.x)` and no static scan can follow that.
- A name is a **leaf or a branch, never both** — `parseNestedCatalog` refuses a dot inside a key,
  so `admin.detail.not-found` and `admin.detail.not-found.fix` cannot coexist. Both keys shipped
  and neither was in the catalog; the leaf is now `…not-found.cause`.

## Commands

```
bun test packages/i18n
bun run --filter @ultimat3/i18n typecheck
```
