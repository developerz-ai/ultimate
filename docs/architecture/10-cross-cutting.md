# Cross-cutting concerns

Four things every Ultimate app gets for free: **i18n, theming, timezones, money**. Every one of them is retrofit hell — each is a change to every string, every colour, every date, and every total in the codebase. So each is enforced at build time, from day one, on the starter template.

Pattern per concern: the rule, the mechanism that makes violating it fail, and the specific bug that stops existing.

## i18n

### Rules

- Zero hardcoded user-facing strings. Everything through `t()`.
- Flat key catalog per locale. No nested lookup at runtime, no key computed by string concatenation.
- A missing key renders **loudly**: `⟦post.publish⟧`.
- Plural selection comes from CLDR via `Intl.PluralRules`. Never `count === 1 ? … : …`.
- Numbers, dates, and money go through `Intl` with explicit options — never a hand-rolled format.

```ts
t('post.publish');                        // static key — extractable
t('cart.items', { count: 3 });            // plural — selects cart.items.{one,other,…}
t('greeting', { name: user.firstName });  // vars are open: a missing one renders the placeholder
```

```json
{ "cart.items.one": "{count} item", "cart.items.other": "{count} items" }
```

### Enforcement

| Mechanism | Detail |
|---|---|
| No hardcoded user-facing string | **a convention, not a rule.** `As of 2026-08` no Biome rule and no gate step refuses a literal outside `t()` — `biome.json` declares no such rule, and `x i18n check` reads `t()` calls, never the strings beside them. Per axiom 3 this is a review discipline until a check exists |
| Loud miss | dev renders `⟦key⟧`; the string is impossible to miss in a screenshot or a snapshot test |
| Extraction gate | `x i18n check` — scan every `t()` call → the key set; diff against every configured locale's catalog. A key missing in **any** locale is `X_CATALOG_MISSING_KEYS` with `fix: x i18n sync <locale>` |
| `x i18n add <locale>` | takes a **locale**, not a key: it creates that locale's catalog file. `x i18n sync <locale>` is the one that writes the missing keys into it |
| Unused keys | reported by `x i18n check` and never a failure — only `missing` becomes a finding (`packages/cli/src/cmd-i18n.ts:102-108`). **No command removes them**: there is no `prune`, planned or shipped. Delete the key from `packages/i18n/catalogs/<locale>.json` by hand |
| Dynamic keys | extraction cannot see `t(someVar)`. `x i18n check` **reports** each one with its file, line and expression, and `runtimeKeyPatterns` uses them to stop the unused half firing on a key only a template reaches. It is not a build error and there is no `t.oneOf` |
| Typed keys | `TranslationKey<TCatalog>` makes an unknown **key** a compile error. The interpolation **vars** are not typed against the catalog string — `vars?: TranslateVars` is optional and open (`packages/i18n/src/translator.ts:46`), so a missing slot renders the placeholder rather than failing to compile |
| Plural completeness | selection is `Intl.PluralRules`, CLDR categories, never an English `n === 1` (`packages/i18n/src/interpolate.ts:57-70`). A **missing** category falls back at runtime; no gate step requires a locale to supply every category it uses |
| SEO | `hreflang` reciprocal set + per-locale prerender come from the route table ([`../idea/07-rendering-seo.md`](../idea/07-rendering-seo.md)) |

### Bugs prevented

| Bug | Why it cannot happen |
|---|---|
| "1 items" | plural category comes from CLDR (`Intl.PluralRules`), never `count === 1`. A category the catalog omits falls back down `pluralKeyCandidates` rather than rendering the English form |
| Russian/Polish/Arabic plurals silently wrong | same — `one/other` is not a valid `ru` catalog |
| English leaking into `/es/` | a key missing from `es` renders `⟦key⟧`, and `x i18n check` reports it as `X_CATALOG_MISSING_KEYS`. `x verify` has no i18n step, so this one is a command you run, not a step you inherit |
| A string that never gets translated | `x i18n check` names it — but only once it is inside a `t()`. A literal outside one is still reachable, see Enforcement above |
| Sentences broken by concatenation | the whole sentence is one catalog entry, so word order is the translator's decision rather than the caller's |

## Theming

### Rules

- Semantic tokens only: `--surface`, `--text-muted`, `--danger-fg`. Never a raw hex, never a palette name, in any component or stylesheet.
- One token source of truth. Everything else is generated from it.
- `data-theme` beats the media query.
- The theme is applied **before first paint**.

```scss
/* apps/web/shared/ui/card.module.scss */
.card {
  background: var(--surface-raised);
  color: var(--text-default);
  border: 1px solid var(--border-subtle);
}
```

```ts
// packages/ui/src/tokens.ts — the single source
export const tokens = {
  surface: { light: palette.white, dark: palette.slate900 },
  'surface-raised': { light: palette.slate50, dark: palette.slate800 },
  'text-default': { light: palette.slate900, dark: palette.slate50 },
} as const;
```

Generated from it: the CSS custom properties for both themes, the TS union of valid token names, and the manifest entry the SEO/PWA layers read for `theme_color`.

### Enforcement

| Mechanism | Detail |
|---|---|
| No raw colour | **a convention, not a rule.** `As of 2026-08` there is no `raw-hex` lint rule and no gate step that refuses a colour literal in a component or `.scss` module. The check that should exist would scan the same file set `errors` and `filesize` already walk |
| Token existence | `ColorRole` is a union derived from `colorTokens`, so naming a token TypeScript does not know is a compile error **in TS**. A `var(--foo)` in SCSS is not checked against it — SCSS is not typechecked |
| Contrast | `contrastRatio` / `meetsContrast` measure every pairing against `AA_TEXT` (4.5) and `AA_LARGE` (3), and `packages/ui/src/tokens/contrast.test.ts` fails on a pair that misses. That is the framework's own palette and a brand override run through the same function; it is a **test**, so it reaches the gate through the `unit` step, not through a check of its own |
| Specificity | generated CSS emits `@media (prefers-color-scheme: dark)` **first**, then `:root[data-theme="dark"]` / `:root[data-theme="light"]` overrides — so an explicit choice always wins in both directions |
| Pre-paint script | a byte-capped inline `<script>` in `<head>`, counted against the route budget by `measureDocumentJs`. Nothing fails a route that omits it |
| Inline `<style>` | `style-csp.ts` computes the `style-src` sha256 of every inline `<style>` the web role serves, so a CSP does not need `'unsafe-inline'` |
| SSR path | the theme cookie is read during `locale-negotiate` (stage 5), so server-rendered HTML already carries `data-theme`; the inline script is the fallback for `static`/`isr` pages served from cache |

```html
<script>try{var t=localStorage.getItem('x-theme')||'system';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):t}catch(e){}</script>
```

### Bugs prevented

| Bug | Why it cannot happen |
|---|---|
| White flash before dark theme paints | the attribute is set before body renders, in the same document |
| One component stays light in dark mode | in TS, `ColorRole` admits no non-token name. In SCSS, nothing stops a literal — this one is a review discipline |
| A user's explicit "dark" overridden by their OS switching to light | `data-theme` selectors are emitted after, and win over, the media query |
| Unreadable text after a palette tweak | `contrast.test.ts` measures every pairing against AA and fails the `unit` step |
| Two sources of truth drifting (CSS vars vs. a TS theme object) | there is one file; both are generated |

## Timezones

### Rules

- **Store UTC.** `timestamptz` columns, `Instant` in TS.
- **Format with an explicit IANA zone.** Never a call without `timeZone`.
- A wall-clock date with no instant (birthday, invoice date) is a `PlainDate`, not a timestamp.
- Cron requires an explicit `tz`.

```ts
import { formatDateTime } from '@ultimat3/time';

formatDateTime(post.publishedAt, {
  locale: ctx.locale,
  zone: ctx.tz,
  dateStyle: 'medium',
  timeStyle: 'short',
});
```

### Enforcement

| Mechanism | Detail |
|---|---|
| Type-level, and it is the whole enforcement | `FormatContext.zone` is **required** on every `@ultimat3/time` formatter (`packages/time/src/format.ts:14-18`), so an omitted zone does not compile. `ctx.tz` is always available ([`03-request-lifecycle.md`](./03-request-lifecycle.md)) |
| A bare `Intl.DateTimeFormat` / `toLocaleString` | **a convention, not a rule.** There is no `date-no-tz` lint rule `As of 2026-08`. The type covers every call that goes through `@ultimat3/time`; a direct `Intl` call bypasses it, and nothing refuses one |
| Schema-level | a `date` (no time) column maps to `PlainDate`; assigning an `Instant` to it does not compile |
| Test-level | tests run at a fixed instant in `UTC`; a tz-dependent bug fails deterministically ([`14-testing-internals.md`](./14-testing-internals.md)) |
| Cron | `tz` is a required field of `task()`. Omitting it is a compile error |
| Boot | `app.config.ts`'s `timeZone` is validated by `isTimeZone` against `Intl.DateTimeFormat` (`packages/core/src/config.ts:157-164`); a non-IANA name is `X_CONFIG_INVALID`. It is a **config** field, not an env variable — there is no `DEFAULT_TZ` in the env schema |

### DST gap and overlap policy

Two hours a year are not ordinary. The policy is explicit and the default is stated.

| Case | Example | Default | Alternatives |
|---|---|---|---|
| **Gap** (spring forward) — a wall time that does not exist | `2026-03-29 02:30` in `Europe/Berlin` | `gap: 'next'` — shift forward to `03:30` | `'throw'` → `X_DST_NONEXISTENT`; `'previous'` → `01:30` |
| **Overlap** (fall back) — a wall time that happens twice | `2026-10-25 02:30` in `Europe/Berlin` | `overlap: 'first'` — the first occurrence (DST still in effect) | `'second'`; `'throw'` → `X_DST_AMBIGUOUS` |

`fromZoned(wall, zone, options)` takes a `WallClock` record, never an ISO string — the string form
would need a parse that decides the same question the options answer.

```ts
import { fromZoned } from '@ultimat3/time';

const wall = { year: 2026, month: 3, day: 29, hour: 2, minute: 30 };

fromZoned(wall, 'Europe/Berlin'); // → 03:30 local (gap: 'next')
fromZoned(wall, 'Europe/Berlin', { gap: 'throw' }); // → throws X_DST_NONEXISTENT
```

`fromZonedDetailed` returns the same instant plus a `ZonedResolution` — `'exact' | 'gap' |
'overlap'` — for a caller that must know which branch it took.

Cron follows the same policy, plus a firing guarantee:

| Situation | Behavior |
|---|---|
| Cron time falls in a gap | fires **once**, at the shifted instant |
| Cron time falls in an overlap | fires **once**, at the earlier instant — deduped by the scheduled UTC instant |
| Scheduler restarts across the boundary | the enqueued job's `idempotencyKey` absorbs a double-fire ([`08-jobs-internals.md`](./08-jobs-internals.md)) |
| Missed tick | fires late rather than being skipped |

### Bugs prevented

| Bug | Why it cannot happen |
|---|---|
| "Your 2am report" runs at 3am for half the year | the task declares `tz`, and gap/overlap policy is defined |
| The nightly digest sends twice on the fall-back night | overlap fires once, and the idempotency key covers handover |
| Dates render in the server's zone for a user in Auckland | formatting without `timeZone` does not compile |
| A birthday off by one day | `PlainDate` has no instant to shift |
| A tz bug that only reproduces in October | tests are deterministic under a frozen clock and a fixed zone |

## Money

### Rules

- `Money = { readonly minor: number; readonly currency: string; readonly scale?: number }`. **Never a float, never a bare number, never a `bigint`.** One declaration, in `@ultimat3/schema` — `money` and `entity` alias it and never restate it.
- The currency travels with the amount, always.
- The minor-unit exponent comes from the ISO 4217 table — never assumed to be 2. `scale` overrides it for a sub-cent amount, which is why a $0.00016 model call is expressible instead of rounded up to a whole cent.
- Cross-currency arithmetic is **refused**, not silently coerced.
- Splitting money loses nothing.

```ts
import { add, formatMoney, type Money } from '@ultimat3/money';

const price: Money = { minor: 1999, currency: 'USD' }; // $19.99
add(price, { minor: 500, currency: 'USD' }); // { minor: 2499, currency: 'USD' }
add(price, { minor: 500, currency: 'EUR' }); // throws X_CURRENCY_MISMATCH
formatMoney(price, 'en-US'); // '$19.99'
```

### Enforcement

| Mechanism | Detail |
|---|---|
| Type-level | every arithmetic function takes `Money`, returns `Money`. There is no `number` overload to fall into |
| Currency check | runtime guard on every binary op → `X_CURRENCY_MISMATCH` naming both currencies. Conversion is an explicit `convert(money, rate, to)` call with the rate as data |
| A money field typed `number` | **a convention, not a rule.** There is no `money-as-number` lint rule `As of 2026-08`; the type only bites where a signature already says `Money`. The check that should exist would read entity column declarations, where the name and the type are both visible |
| Schema-level | the entity helper `money('price')` emits an integer column + a currency column and infers `Money` — a float column for money is a build error |
| Exponent table | `exponentOf('JPY') === 0`, `'USD' === 2`, `'KWD' === 3`, from the ISO table shipped in `@ultimat3/money`. `moneyScale(amount)` is `amount.scale ?? exponentOf(amount.currency)`, and parsing and formatting both read it |
| Rounding | only at explicit boundaries, with a named mode (`half-even` default). No implicit rounding inside arithmetic — there is nothing to round, integers are exact |
| Allocation invariant | property test asserts `sum(allocate(total, ratios)) === total` for random totals and ratios, including negatives |
| Formatting | `Intl.NumberFormat` with `style: 'currency'` at the edge only; a `Money` is never string-formatted for storage or transport |

```ts
import { allocate, allocateByRatios } from '@ultimat3/money';

allocate({ minor: 1000, currency: 'USD' }, 3);
// → [{ minor: 334 }, { minor: 333 }, { minor: 333 }] — largest-remainder, sums to 1000

// `allocate` takes a COUNT. Uneven splits are the ratios form:
allocateByRatios({ minor: 1000, currency: 'USD' }, [2, 1, 1]);
```

`allocate` distributes the remainder to the largest fractional parts first, deterministically ordered by input index for ties. Sum is exact by construction, not by luck.

### Bugs prevented

| Bug | Why it cannot happen |
|---|---|
| `0.1 + 0.2` in an invoice total | there are no floats; minor units are integers |
| Splitting $10.00 three ways and losing a cent | `allocate` is remainder-preserving and property-tested |
| `¥100` formatted as `¥1.00` | the exponent comes from the ISO table, not from an assumption |
| Adding USD to EUR and shipping the sum | the currency is attached and the op refuses |
| A price that arrives as `19.99` from an API and rounds badly | parsing is `Money`-typed at the boundary, exponent-aware |
| A `total` column drifting to `real` | a float money column is a build error |
