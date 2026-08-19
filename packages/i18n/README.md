# 🌍 @ultimat3/i18n

**Golden rule: no user-facing string is written twice, and a missing one is loud.**
Every string goes through `t()`. A key with no translation renders `⟦key⟧` — never blank,
never the English fallback, never silence. Numbers, dates and money are **not** i18n
strings: format those with `Intl` via [@ultimat3/money](../money) and [@ultimat3/time](../time).

| Concern | Owner | Rule |
|---|---|---|
| Registration | `define-catalogs.ts` | `defineCatalogs()` — one call, at boot, per app |
| Lookup + interpolation | `translator.ts` | `t(key, vars?)`, miss → `⟦key⟧` |
| Catalog shape | `catalog.ts` | nested authoring → flat dot-keys |
| Placeholders + plurals | `interpolate.ts` | `{var}`, CLDR categories via `Intl.PluralRules` |
| Locale resolution | `locales.ts` | supported set, `normalizeLocale`, `negotiateLocale` |
| Request locale | `context.ts` | resolved once, read from ALS — never passed by hand |
| Enforcement | `extract.ts` | `x verify` fails on a missing key in a shipped locale |

## Declare the catalogs, once

`defineCatalogs` is the only way an app registers strings. Never call `registerCatalog` by hand.

```ts
// the app's own packages/i18n/src/index.ts — its whole i18n module
import { defineCatalogs, type TranslationKey, type Translator, useI18n } from '@ultimat3/i18n';
import en from '../catalogs/en.json';
import es from '../catalogs/es.json';

export const catalogs = defineCatalogs({ default: 'en', locales: { en, es } });

export type AppCatalog = typeof en;
export type AppKey = TranslationKey<AppCatalog>; // 'nav.home' | 'posts.likes' | …
export const useT = (): Translator<AppCatalog> => useI18n<AppCatalog>();
```

| One call | Because |
|---|---|
| validates + flattens every locale before registering any | a malformed catalog fails the boot whole, never half |
| registers the framework catalog under `en` first, the app's second | later wins, so app strings override framework strings |
| `configureLocales({ supported, fallback })` | the locale set is declared once, not twice |
| returns `{ default, locales, catalogs, keys() }` | the app's key space, for tests and tooling |

A `default` outside `locales` is `X_LOCALE_UNSUPPORTED` — and a compile error before that.

## Read a string

```ts
import { negotiateLocale, t } from '@ultimat3/i18n';

// per-request: the HTTP layer resolves the locale once
const locale = negotiateLocale(request.headers.get('accept-language')); // 'de'

// anywhere downstream — no locale argument, ever
t('pagination.showing', { from: 1, to: 20, total: 137 });
t('pagination.result', { count: 1 });   // "1 result"
t('pagination.result', { count: 9 });   // "9 results"
t('nav.settings');                      // "⟦nav.settings⟧" — fix it or ship it broken, visibly
```

| Call | Returns | Use for |
|---|---|---|
| `t(key, vars?)` | `string` | one string, framework or app, untyped keys |
| `useI18n<AppCatalog>()` | `Translator<AppCatalog>` | a component rendering several — unknown key is a build error |
| `translatorFor(locale)` | `Translator` | an explicit locale: mail, a worker tick, a preview |

`Translator` with no type argument keeps taking any `string`, which is what `@ultimat3/ui` and
`@ultimat3/mail` are built against. `has()` and `raw()` stay permissive on purpose — a probe for
a key that may not exist is what they are for.

## Plurals are CLDR, not `n === 1`

Author two forms with `key` / `key_plural`, or all forms a locale needs with
`key_<category>` where category is `zero | one | two | few | many | other`.

```json
{ "files": { "n_one": "{count} plik", "n_few": "{count} pliki", "n_many": "{count} plików" } }
```

`t('files.n', { count: 3 })` → `3 pliki`, `{ count: 5 }` → `5 plików`. Selection runs
through `Intl.PluralRules`, so Polish, Russian and Arabic work without a special case.

Suffixes are underscores on the leaf, never a nested `{ one, other }` branch: the runtime probes
`files.n_few`, and `TranslationKey` admits the stem `files.n` for exactly the same reason.

## Catalogs

Author nested and feature-namespaced; `defineCatalogs` flattens to dot-keys and rejects a
non-string leaf with `X_CATALOG_INVALID`. Registration order is framework then app — later
wins, which is how an app overrides `errors.notFound.title` without forking the framework.

`src/catalogs/en.json` ships the framework's own strings: `errors.*`, `auth.*`,
`pagination.*`, `admin.*`, `validation.*`, `common.*`, `time.cron.*`.

**It is registered under `en` and no other locale** — the golden rule applies to framework strings
too. An app shipping `es` that has not translated `errors.notFound.title` renders
`⟦errors.notFound.title⟧` there, not `Page not found`: filling every locale with the English
catalog is a fallback chain, it reads as `isMiss === false`, and `assertCatalogsComplete` cannot
see it because `CatalogSet.catalogs` carries app strings only. Translate the framework keys your
app renders into your own catalog — that is the one path, and it is the same merge an override is.

## Enforcement

`extractKeys()` scans source for `t('...')` calls; `auditCatalogs()` reports keys used,
keys missing per locale, and keys defined but never used; `assertCatalogsComplete()` is
the `x verify` gate.

```
X_CATALOG_MISSING_KEYS: catalog is incomplete
  cause: packages/i18n/catalogs/es.json is missing 2 key(s) used in source: admin.nav.jobs, common.save
  fix:   x i18n sync es
```

## Errors

| Code | When |
|---|---|
| `X_LOCALE_UNSUPPORTED` | a tag outside the supported set was asserted, or a `defineCatalogs` default that is not one of its locales |
| `X_CATALOG_MISSING_KEYS` | a shipped locale lacks a key the source uses |
| `X_CATALOG_INVALID` | non-string leaf, bad key segment, or a dotted/nested collision |

## Why it exists

Retrofitting i18n means touching every string in the app. Structuring for many locales on
day one costs nothing; the loud-miss rule is what keeps it honest once there are two.
