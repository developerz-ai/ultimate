# @postly/i18n

Two catalogs, both complete, and one typed translator.

```tsx
const t = useT();
<h1>{t('site.hero.title')}</h1>
<p>{t('app.post.likes', { count: post.likeCount })}</p>
```

`useT()` is typed against `catalogs/en.json`, so a key that does not exist is a **compile error**
and a key that exists but is missing from `es.json` is an `x verify` failure. In dev a miss renders
`⟦key⟧` — loud, greppable, and impossible to mistake for copy.

## Catalogs

| File | Locale | Keys |
|---|---|---|
| `catalogs/en.json` | `en` (default) | 143 |
| `catalogs/es.json` | `es` | 143 — parity asserted in `src/catalog.test.ts` |

Namespaced by feature, not by page, because a string moves between pages and never between
features:

```
common.*     buttons and words shared by every surface
site.*       hero, features, pricing, blog, offline — the static surface
app.*        nav, feed, post, settings — the authed surface
posts.* orgs.* plans.*   feature vocabulary, reused by web, admin and MCP descriptions
mail.* digest.*   emails the worker renders in the member's own locale
errors.*     user-facing text for the error codes a user can actually cause
```

## Plurals and interpolation

```json
"likes_one": "{count} like",
"likes_other": "{count} likes"
```

Call it as `t('app.post.likes', { count })`. The category is chosen by `Intl.PluralRules` for the
active locale — never by `count === 1` in a component. Numbers, dates, and money inside a string
are formatted by `Intl` with the member's locale and explicit timezone.

## Rules

- A new user-facing string lands in **both** catalogs in the same commit. An English string in
  `es.json` is worse than `⟦key⟧`: it looks finished.
- No string concatenation across keys — word order is not universal. One key per sentence.
- No HTML in a catalog value. Structure lives in the component, text lives here.
- The digest email is rendered server-side with `member.locale`, so catalogs are loaded in the
  `worker` role too. Nothing here may depend on the DOM.
