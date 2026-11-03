# 41 — What a site says: `llms.txt`, mail previews, grammatical choice, amounts typed by a person, the visitor's zone

> Part of [`overview.md`](overview.md). Depends on: [`24-web-i18n-mail-keys.md`](24-web-i18n-mail-keys.md). Tier: 0 (`core`), 1 (`i18n`, `money`, `seo`, `time`), 2 (`http`), 4 (`mail`, `render`), 5 (`admin`, `cli`).

## Why
| Gap | Evidence |
|---|---|
| `llms.txt` is claimed and absent | `docs/idea/07-rendering-seo.md:105`, `wiki/Routes-And-Render-Modes.md:369` state it. `grep -i llms` over `seo/src`, `render/src`, `cli/src` finds no generator, and `/llms.txt` 404s on any app. `robots.txt` and `sitemap.xml` are one answer served two ways (`cli/src/seo-routes.ts`, `site-seo-write.ts`): this is one more row |
| A mail is seen only once sent | the dev panel shows caught mail (`admin/src/dev/panel-mail.ts:1`). `renderMessage` exists "which previews call" (`mail/src/mail.ts:113,182`), and no preview calls it. Checking a template in five locales means triggering five flows |
| No grammatical select or ordinal | `t()` has CLDR plurals through key suffixes (`i18n/src/interpolate.ts:393`), nothing else. Probe, ICU-style text printed `{gender, select, female ⟦her⟧ other ⟦their⟧}`. "1st, 2nd" and gendered agreement cannot be translated correctly; translators ask by locale |
| A typed amount has no parser | `fromDecimal` takes `12.99` (`money/src/money.ts:62`). A German user types `1.234,56`. Each form hand-parses or stores 1.234 euros. `Intl` has the separators: probe `de-DE` parts `integer:1 group:. integer:234 decimal:, fraction:5` |
| First paint is in UTC | the zone sources are user, cookie, query, header (`time/src/context.ts:14-24`). A document navigation sends no `x-timezone`, so a new visitor sees UTC in server-rendered `app/` pages until they choose |

## Decisions
| Question | Answer |
|---|---|
| ICU message syntax | **no**. A second way beside suffix plurals and a parser in every island. The suffix mechanism takes the same cases: `_ordinal_one`, `_select_female`, in one flat catalog |
| Numbers in a message | `Intl` stays the documented way (`wiki/I18n.md:179`); no `formatNumber`, no `{n, number}` |
| `llms.txt` contents | the wiki's row: `site/` routes' titles and descriptions. No per-page Markdown, no `llms-full.txt`. The repo's own `llms.txt` is a separate hand-kept file and does not move |
| Opt-out | `seo.llms: false`. On by default, like the sitemap; indexable routes only, same filter |
| Mail preview data | a declared `preview` on `defineMail`, type-checked against its input. Never production rows |
| Zone writer | never touches the chosen cookie (`time/src/context.ts:40`). A separate `x_timezone_detected`, ranked below `header`. An explicit choice still beats a guess |

## Files to change
- `packages/seo/src/llms.ts` (new) — `buildLlmsTxt(routes, site)`; `packages/seo/src/index.ts`.
- `packages/cli/src/site-seo.ts:17`, `seo-routes.ts`, `site-seo-write.ts`, `dev-route-table.ts:166`, `serve-web.ts:138` — one more artifact.
- `docs/idea/07-rendering-seo.md:105`, `wiki/Routes-And-Render-Modes.md:369`, `wiki/SEO.md` — the rule and the opt-out.
- `packages/mail/src/mail.ts:31` — `MailInit.preview?: I | ((locale) => I)`.
- `packages/admin/src/dev/panel-mail.ts`, `data.ts:56`, `facts.ts:218` — a "templates" list beside caught mail; a render per locale.
- `packages/cli/src/cmd-mail.ts`, `cmd-mail-spec.ts` (new) — `x mail preview <id> [--locale] [--out] [--json]`.
- `packages/i18n/src/interpolate.ts:94`, `translator.ts:17-62`, `extract.ts:166`, `subset.ts:35` — `{ ordinal }` and `{ select }` selection.
- `packages/money/src/parse-input.ts` (new); `index.ts` — `parseAmount`.
- `packages/time/src/context.ts:14,21`, `packages/http/src/preferences.ts:32` — `detected` source.
- `packages/render/src/zone-script.ts` (new); `packages/cli/src/` document assembly — on `app/` documents only, under `time.detect`.
- `examples/dummy/` — `preview` on one mail; one ordinal and one select key per locale; `parseAmount` in one action; `time.detect: true`.
- `wiki/Mail.md`, `wiki/I18n.md`, `wiki/Money.md`, `wiki/Timezones-And-Dates.md`, `wiki/CLI-Reference.md`, READMEs, `wiki/Error-Codes.md`.

## Steps
1. `/llms.txt`: `# <site name>`, description, then `- [title](url): description` per indexable `site/` route, expanded through `prerender()`, default locale. Static export writes the same bytes. Same production rule as `robots.txt`: anything but `production` answers an empty document.
2. `seo` step: a listed route with no description is `X_SEO_LLMS_DESCRIPTION_MISSING`. Convention's build error; only where `seo.llms` is on.
3. `x mail preview`: `renderMessage(mail, preview, { locale, tz })`, writes html and text, `--json` names missing keys. `x verify`'s `i18n` step renders every declared preview in every locale, so a preview is also a test.
4. `t('place', { ordinal: 2 })` picks `place_ordinal_two` via `Intl.PluralRules({ type: 'ordinal' })`, then `_ordinal_other`. `t('invite', { select: 'female' })` picks `invite_select_female`, then `_select_other`. Each composes with `count`: `invite_select_female_one`. The type admits a stem as `PluralStem` does (`translator.ts:21`).
5. `extract.ts`: each family counts as used, so `x i18n check` audits them. Missing `_other` is `X_I18N_FAMILY_INCOMPLETE`: the convention's build error.
6. `parseAmount(text, { currency, locale })` answers `Money`. Separators from `Intl.NumberFormat.formatToParts`, including Arabic digits and non-breaking group spaces. Ambiguous or too many fraction digits for the currency is refused, never rounded: `1,234` in `en-US` is 1234, and in `de-DE` is 1.234 and refused for EUR at 3 decimals. No float ever: hand on to `fromDecimal`.
7. `time.detect: true`: an inline script, under 200 B, on `app/` documents with no zone cookie: writes `x_timezone_detected` from `Intl.DateTimeFormat().resolvedOptions().timeZone`. Never on `site/` (axiom 6), and it fits the CSP nonce path. Order becomes `user, cookie, query, header, detected`. Invalid is skipped, as `resolveTimeZone` skips. The first paint stays UTC; second is right. Hydration keeps server values.

## Error codes
`bun run new-error-code` for each row.

| Code | When | Fix |
|---|---|---|
| `X_SEO_LLMS_DESCRIPTION_MISSING` (off-socket) | a listed route has no description | add `meta.description`, or `seo.llms: false` |
| `X_MAIL_PREVIEW_INVALID` (off-socket) | `preview` fails `input` | correct `preview` to the schema |
| `X_MAIL_PREVIEW_MISSING` (off-socket) | `x mail preview` on a mail with none | add `preview` to `defineMail` |
| `X_I18N_FAMILY_INCOMPLETE` (off-socket) | a select or ordinal family has no `_other` | add `<key>_select_other` |
| `X_MONEY_INPUT_INVALID` (422) | text unreadable or ambiguous in this locale | re-prompt; `cause` names the character |

## Tests
- `packages/seo/src/llms.test.ts`, `packages/cli/src/seo-routes.test.ts`: served and exported bytes match; `noindex` absent; non-production empty.
- `packages/mail/src/mail.test.ts`, `packages/cli/src/cmd-mail.test.ts`: a bad preview refused at definition; `--json` shape.
- `packages/i18n/src/interpolate.test.ts`: `en` 1st, 2nd, 3rd, 11th; `select` plus `count`; missing `_other`.
- `packages/money/src/parse-input.test.ts`: a table over `en-US`, `de-DE`, `fr-FR` (narrow no-break), `hi-IN`, `ar-EG`, JPY with no decimals, plus every refusal.
- `packages/http/src/preferences.test.ts`: chosen cookie beats detected; header beats detected; bad detected ignored. `packages/cli/e2e/` on a throwaway page: reload shows the browser's zone.
- `bun test packages/money/src/parse-input.test.ts`

## Semver
minor. A generated `/llms.txt` appears, stated in `wiki/Upgrading.md`. A new `seo` check is red for a `site/` route with no description, which `seo` already requires (`seo/src/validate.ts`): verify with a scaffold before calling it minor; if it fires anywhere new it needs an Upgrading row.

## Done when
- `curl /llms.txt` on `examples/dummy` lists its site pages, and the docs' claim is true.
- `bun run verify`, `scaffold-smoke` green.
