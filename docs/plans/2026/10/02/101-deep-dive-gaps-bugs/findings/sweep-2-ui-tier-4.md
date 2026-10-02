# Sweep 2 — ui and tier-4 leftovers, i18n, seo
> Re-checked in [`sweep-3-verify-tier-4-5.md`](sweep-3-verify-tier-4-5.md) — where it corrects a citation or narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `ui` (QR, tokens, theme, catalog, icons, all 62 stylesheets, the components sweep 1 skipped),
> `render` loaders and DOM router, `mcp` dev tools, `manifest` admin, `mail` templates, `ai`
> leftovers, `i18n`, `seo`.
> CONFIRMED = a probe ran. PLAUSIBLE = from reading. Nothing ran in a real browser.

## Critical

### 1. `encodeQr` draws a symbol that is not a valid QR code — every `<QrCode>` is undecodable
- `packages/ui/src/components/qr-matrix.ts:86-99, 111-117, 161-164, 200-206`.
- An independent standard-layout reader over `encodeQr(text).modules`:

| Text | Version | Wrong codewords | Correctable | Finder patterns intact |
|---|---|---|---|---|
| `'A'` | 1 | 11 of 26 | 5 | 3 of 3 |
| `'hello world'` | 1 | 11 of 26 | 5 | 3 of 3 |
| a 20-byte URL | 2 | 27 of 44 | 8 | 1 of 3 |
| a 38-byte URL | 3 | 48 of 70 | 13 | 1 of 3 |

- Four independent placement defects:

| Lines | Defect |
|---|---|
| `:86-99` | a second "separator" ring at ±5 from each finder centre; the finder's own `dist === 4` ring is the separator. Claims 14 data modules, shifts the bit stream, blanks the timing modules at (6,8), (8,6) |
| `:111-117` | only the (6,6) alignment centre is skipped; versions 2–3 also draw alignment patterns at (6, last), (last, 6), over the top-right and bottom-left finders |
| `:200-206` | the column walk never applies `if (right === 6) right = 5`; column 0 is never written |
| `:161-164` | the second format-info copy is transposed; it also overwrites the fixed dark module at (`size-8`, 8) |

- CONFIRMED: a scratch copy with exactly these four edits matches a reference encoder module for module on seven inputs across versions 1–3.
- Correct already: `formatInfoBits`, `buildCodewords` (Reed–Solomon syndromes zero), `applyMask`.
- Why it shipped: `qr-encode.test.ts:18` asserts size, three finder-centre modules, `darkCount > 0` — no known vector.
- Test: `packages/ui/src/components/qr-encode.test.ts` — one full published matrix per version, or decode-and-compare codewords.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 2 | `packages/render/src/navigation.ts:125,139`, `navigation-history.ts:37-43` | the router sets `scrollRestoration = 'manual'` and never restores a saved offset on a fresh document load; `saveScroll()` at boot overwrites it | an entry with a saved scroll of 2000, a full load away and Back (or F5) → `scrollY` 0, state rewritten to `[0, 0]`. Applies whenever bfcache does not restore — the router's open `BroadcastChannel` (`:127`) is a known bfcache blocker | CONFIRMED (`navigation-dom-fixture`); real-browser consequence PLAUSIBLE | at start read `entryOf(history.state)` and `scrollTo` before the first `saveScroll()`; close the channel on `pagehide` | `packages/render/src/navigation.test.ts`; a case in `packages/cli/e2e/client-navigation-*.e2e.test.ts` |
| 3 | `packages/ui/src/components/CommandPalette.module.scss:6,24,33`, `Tooltip.module.scss:12-13,39`, `Popover.module.scss:44-47` | centring pairs a logical inset (`inset-inline-start: 50%`) with a physical `translate(-50%)` | under `dir="rtl"` the box spans `[c − 1.5w, c − 0.5w]` — on a 390 px phone the palette sits almost entirely off-screen. `Popover.tsx:1-3` claims it "flips sides automatically" | PLAUSIBLE (CSS semantics) | `inset-inline: 0; margin-inline: auto`, or the `[dir='rtl']` sign flip of `Switch.module.scss:51-57` | a sass-probe test: no `translate(-50%` beside `inset-inline-start` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 4 | `packages/ui/src/theme/brand.ts:64-78` | a light-only override leaks into OS-dark documents with no `data-theme` — the brand `:root` follows `theme.scss`'s dark media `:root` at equal specificity | `defineTheme({ colors: { light: { accent } } })`, scripting off or the boot script's storage read throwing → the light accent on the dark palette, 1.74:1. `assertContrast` measured light only | CONFIRMED (emitted CSS, ratios) | `packages/ui/src/theme/brand.test.ts` |
| 5 | `packages/ui/src/a11y.ts:36-39` | `useId` is a per-module counter from 0; each island bundle has its own | two islands each rendering a `Field` / `Dialog` / `Popover` / `Tooltip` both mint `field-1`; `aria-describedby` and `for` resolve to the first match. Server ids are process-order dependent — an ISR regeneration of an unchanged page changes its bytes. No tracked-app island uses one of the 14 id-minting components today | PLAUSIBLE | `packages/ui/src/a11y.test.ts` |
| 6 | `packages/ui/src/components/Textarea.tsx:53` | the unconditional leading `\n` is stripped only by the HTML parser | in an island `<Textarea value="abc">` holds and submits `"\nabc"` | PLAUSIBLE | `packages/ui/src/components/interaction.test.ts` |
| 7 | `packages/seo/src/robots.ts:70-75` | `seo.robots.disallow` dropped when the declared groups name no `*` | `groups: [{ userAgent: 'Googlebot', allow: ['/'] }]`, `disallow: ['/admin']` → no `Disallow: /admin` anywhere. Documented as "paths every crawler is kept out of" | CONFIRMED | `packages/seo/src/robots.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/render/src/css-modules.ts:84,151` | `scopeClasses` runs the class regex over the whole sheet — `src:local(Inter.Regular)` → `local(Inter.Regular_H)`; an escaped-dot class is split; comments gain phantom classes. Fix: selector preludes only | CONFIRMED |
| `packages/render/src/css-modules.ts:316` | the scope suffix hashes basename + source only — two `page.module.scss` with identical source and different imported partials emit one class name with two bodies; the later wins on both pages | CONFIRMED |
| `packages/i18n/src/translator.ts:75` | `interpolate` skipped when `vars` is omitted — `t('a')` on `'Hello {name}'` returns the raw placeholder, not the loud `⟦name⟧` that `t('a', {})` gives; `{{x}}` is not unescaped | CONFIRMED |
| `packages/ui/src/components/relative-time-view.ts:36-39` | unit chosen before rounding — "60 minutes ago", "24 hours ago", "7 days ago" | CONFIRMED |
| `packages/ui/src/components/bar-chart-view.ts:53` | bar width negative past 201 points — an invalid `<rect>` | CONFIRMED |
| `packages/ui/src/components/Dropzone.module.scss:28-29`, `FileInput.module.scss:54-55` | `@include t.disabled` nested under a selector that can never be `:disabled` — the dim never applies | CONFIRMED (compiled output) |
| `packages/ui/src/components/Tabs.module.scss:22` | vertical indicator is a physical `inset -2px 0` shadow beside a logical border — wrong edge in RTL | PLAUSIBLE |
| `packages/ui/src/components/link-target.ts:22` | "external" is `/^https?:\/\//` on the raw string — protocol-relative, upper-case and leading-space URLs are classed internal: no `rel` hardening, no `externalHint` | CONFIRMED |
| `packages/ui/src/components/Meter.tsx:52-53` | `aria-valuenow` / `aria-valuemax` are the raw props while the fill is clamped | PLAUSIBLE |
| `packages/ui/src/components/Popover.tsx:66` | `aria-controls` names the panel id while the panel is unmounted | PLAUSIBLE |
| `packages/ui/src/icons/build-icons.ts:30,72` | a non-JSON 200 body throws a bare `SyntaxError` (contract: `X_UI_INVALID_VALUE`); a non-array node is skipped — a partial glyph is written | CONFIRMED |
| `packages/render/src/navigation.ts:402-405` | a urlencoded POST body built from `FormData` without the CRLF normalisation a native submit applies | PLAUSIBLE |
| `packages/render/src/navigation.ts:277-278`, `navigation-swap.ts:60-74` | sheets appended for a navigation then aborted are never owned or removed | PLAUSIBLE |
| `packages/render/src/navigation-dom.ts:75-78` | an older transition's `finished` calls `track(undefined)` after a newer one started; the lost-click repair (`navigation.ts:355`) does not run | PLAUSIBLE |

## Gaps

- No known-vector or decode test for QR. No RTL assertion on any stylesheet.
- No contrast gate on `MAIL_TOKENS` (measured: all pairs pass AA; lowest 4.53).
- `heading-level.test.ts:17`, `date-time-view.test.ts:66`, `money-view.test.ts:49` use `throw new Error('expected a throw')` as the verdict — the rule is `expect.unreachable`.
- `Dropzone.tsx:79-80` hands every dropped file to the `<input>`, rejected ones included — nothing enforces `maxBytes` / `accept` at submit.
- `sass-cache.ts` has no negative dependencies: a partial added later that would shadow a load-path hit does not invalidate the entry.

## Not a bug (do not re-open)

- Raw colours and lengths in `.scss` — only `transparent`, `currentcolor`; the raw-length guard runs over `packages/ui` (`scaffold-guards-style.test.ts:128`).
- Reduced motion — the global guard in `reset.scss:148-160`.
- `Switch` RTL; `QrCode.module.scss` dark inversion; contrast math; `defineTheme` value validation.
- Mail templates — escaping, single-pass interpolation, scheme guard, zoned dates, plural keys.
- `mcp` `dev-ui-tools`, `dev-ui-interact`, `dev-host`; `manifest` `diff-admin`, `sources-admin`; the six `ai` leftovers.
- Render loaders — `sass-cache` keying, `stylesFor` ordering, the reload query strip.
- Router — modifier, target, download, rel-external, cross-origin rules; cache TTL and LRU.
- Non-reactive early returns in `Image`, `Meter`, `LocaleSwitcher`, `Divider`, `Accordion` — props that do not change after mount.
- i18n plural candidate chain, catalog null-prototyping, `extract`; seo `xml` escaping, sitemap `x-default`, `links.ts`.

## Still not read

- `ui`: `fake-dom`, `theme/context`, `provider`, `solid-adapter`, `inert-runtime`, the glyph modules, most `*.test.ts` bodies.
- `i18n/locales`; `seo` `meta`, `images`, `image-driver`, `rss`, `feed-dates`, `validate` (sweep 1 read these).
