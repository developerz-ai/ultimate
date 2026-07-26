# 🌍 @ultimat3/i18n

**Golden rule: no user-facing string is written twice, and a missing one is loud.**
Every string goes through `t()`. A key with no translation renders `⟦key⟧` — never blank,
never the English fallback, never silence. Numbers, dates and money are **not** i18n
strings: format those with `Intl` via [@ultimat3/money](../money) and [@ultimat3/time](../time).

| Concern | Owner | Rule |
|---|---|---|
| Lookup + interpolation | `translator.ts` | `t(key, vars?)`, miss → `⟦key⟧` |
| Catalog shape | `catalog.ts` | nested authoring → flat dot-keys |
| Placeholders + plurals | `interpolate.ts` | `{var}`, CLDR categories via `Intl.PluralRules` |
| Locale resolution | `locales.ts` | supported set, `normalizeLocale`, `negotiateLocale` |
| Request locale | `context.ts` | resolved once, read from ALS — never passed by hand |
| Enforcement | `extract.ts` | `x verify` fails on a missing key in a shipped locale |

## Use

```ts
import { createTranslator, flattenCatalog, negotiateLocale, t } from '@ultimat3/i18n';

// per-request: the HTTP layer does this once
const locale = negotiateLocale(request.headers.get('accept-language')); // 'de'

// anywhere downstream — no locale argument, ever
t('pagination.showing', { from: 1, to: 20, total: 137 });
t('pagination.result', { count: 1 });   // "1 result"
t('pagination.result', { count: 9 });   // "9 results"
t('nav.settings');                      // "⟦nav.settings⟧" — fix it or ship it broken, visibly
```

## Plurals are CLDR, not `n === 1`

Author two forms with `key` / `key_plural`, or all forms a locale needs with
`key_<category>` where category is `zero | one | two | few | many | other`.

```json
{ "files": { "n_one": "{count} plik", "n_few": "{count} pliki", "n_many": "{count} plików" } }
```

`t('files.n', { count: 3 })` → `3 pliki`, `{ count: 5 }` → `5 plików`. Selection runs
through `Intl.PluralRules`, so Polish, Russian and Arabic work without a special case.

## Catalogs

Author nested and feature-namespaced; the loader flattens to dot-keys and rejects a
non-string leaf with `X_CATALOG_INVALID`. `mergeCatalogs(framework, app)` — later wins,
which is how an app overrides `errors.notFound.title` without forking the framework.

`src/catalogs/en.json` ships the framework's own strings: `errors.*`, `auth.*`,
`pagination.*`, `admin.*`, `validation.*`, `common.*`, `time.cron.*`.

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
| `X_LOCALE_UNSUPPORTED` | a tag outside the supported set was asserted |
| `X_CATALOG_MISSING_KEYS` | a shipped locale lacks a key the source uses |
| `X_CATALOG_INVALID` | non-string leaf, bad key segment, or a dotted/nested collision |

## Why it exists

Retrofitting i18n means touching every string in the app. Structuring for many locales on
day one costs nothing; the loud-miss rule is what keeps it honest once there are two.
