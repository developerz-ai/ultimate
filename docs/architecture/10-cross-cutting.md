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
t('greeting', { name: user.firstName });  // typed slot — a missing var is a compile error
```

```json
{ "cart.items.one": "{count} item", "cart.items.other": "{count} items" }
```

### Enforcement

| Mechanism | Detail |
|---|---|
| Lint rule `hardcoded-string` | a user-facing literal outside `t()` is a build error ([`02-boundaries.md`](./02-boundaries.md)) |
| Loud miss | dev renders `⟦key⟧`; the string is impossible to miss in a screenshot or a snapshot test |
| Extraction gate in `x verify` | AST-scan every `t()` call → the key set; diff against every configured locale's catalog. A key missing in **any** locale is `X_I18N_MISSING_KEY` with `fix: x i18n add <key>` |
| Unused keys | reported; `x i18n prune --json` removes them. Failing on unused is opt-in, since a key can be used by a template |
| Dynamic keys | extraction cannot see `t(someVar)`. Declare the set: `t.oneOf(POST_STATES, state)` where `POST_STATES` is a const union — then extraction enumerates it. A raw `t(variable)` is a build error |
| Typed slots | interpolation variables are inferred from the catalog string, so `t('greeting', {})` fails to compile |
| Plural completeness | a locale's catalog must supply every CLDR category that locale uses (`ru` needs `one/few/many/other`) — missing category is a build error, not a runtime fallback |
| SEO | `hreflang` reciprocal set + per-locale prerender come from the route table ([`../idea/07-rendering-seo.md`](../idea/07-rendering-seo.md)) |

### Bugs prevented

| Bug | Why it cannot happen |
|---|---|
| "1 items" | plural category comes from CLDR, and the catalog must define the categories the locale uses |
| Russian/Polish/Arabic plurals silently wrong | same — `one/other` is not a valid `ru` catalog |
| English leaking into `/es/` | a key missing from `es` fails the build, not the page |
| A string that never gets translated | it could not be written in the first place |
| Sentences broken by concatenation | slots are typed and ordered by the catalog, so word order is the translator's decision |

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
| Lint rule `raw-hex` | any colour literal (`#hex`, `rgb()`, `hsl()`, a named colour) in a component or `.scss` module is a build error |
| Token existence | `var(--foo)` referencing a token not in `tokens.ts` is a build error — the generated CSS and the checked set come from the same file |
| Palette isolation | `palette.*` is importable **only** by `tokens.ts`; anywhere else is a boundary violation. A component cannot reach a raw colour even indirectly |
| Contrast | generated pairs are checked against WCAG AA at build; a failing pair is a build error with the measured ratio |
| Specificity | generated CSS emits `@media (prefers-color-scheme: dark)` **first**, then `:root[data-theme="dark"]` / `:root[data-theme="light"]` overrides — so an explicit choice always wins in both directions |
| Pre-paint script | a byte-capped inline `<script>` in `<head>`, generated, counted against the route budget. `x verify` fails if it is missing on any route that can render a themed surface |
| SSR path | the theme cookie is read during `locale-negotiate` (stage 5), so server-rendered HTML already carries `data-theme`; the inline script is the fallback for `static`/`isr` pages served from cache |

```html
<script>try{var t=localStorage.getItem('x-theme')||'system';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):t}catch(e){}</script>
```

### Bugs prevented

| Bug | Why it cannot happen |
|---|---|
| White flash before dark theme paints | the attribute is set before body renders, in the same document |
| One component stays light in dark mode | it has no way to name a colour that isn't a token |
| A user's explicit "dark" overridden by their OS switching to light | `data-theme` selectors are emitted after, and win over, the media query |
| Unreadable text after a palette tweak | contrast pairs are checked at build |
| Two sources of truth drifting (CSS vars vs. a TS theme object) | there is one file; both are generated |

## Timezones

### Rules

- **Store UTC.** `timestamptz` columns, `Instant` in TS.
- **Format with an explicit IANA zone.** Never a call without `timeZone`.
- A wall-clock date with no instant (birthday, invoice date) is a `PlainDate`, not a timestamp.
- Cron requires an explicit `tz`.

```ts
fmt.dateTime(post.publishedAt, { timeZone: ctx.tz, dateStyle: 'medium', timeStyle: 'short' });
```

### Enforcement

| Mechanism | Detail |
|---|---|
| Lint rule `date-no-tz` | `Intl.DateTimeFormat`, `toLocaleString`, `toLocaleDateString` without `timeZone` is a build error |
| Type-level | `@ultimat3/time`'s formatters take `timeZone` as a **required** parameter. `ctx.tz` is always available ([`03-request-lifecycle.md`](./03-request-lifecycle.md)) |
| Schema-level | a `date` (no time) column maps to `PlainDate`; assigning an `Instant` to it does not compile |
| Test-level | tests run at a fixed instant in `UTC`; a tz-dependent bug fails deterministically ([`14-testing-internals.md`](./14-testing-internals.md)) |
| Cron | `tz` is a required field of `task()`. Omitting it is a compile error |
| Boot | `DEFAULT_TZ` is in the env schema; an invalid IANA name fails at boot with `X_CONFIG_INVALID` |

### DST gap and overlap policy

Two hours a year are not ordinary. The policy is explicit and the default is stated.

| Case | Example | Default | Alternatives |
|---|---|---|---|
| **Gap** (spring forward) — a wall time that does not exist | `2026-03-29 02:30` in `Europe/Berlin` | `'next'` — shift forward to `03:30` | `'reject'` → `X_TIME_DST_GAP`; `'previous'` → `01:30` |
| **Overlap** (fall back) — a wall time that happens twice | `2026-10-25 02:30` in `Europe/Berlin` | `'earlier'` — the first occurrence (DST still in effect) | `'later'`; `'reject'` → `X_TIME_DST_AMBIGUOUS` |

```ts
zoned('2026-03-29T02:30', 'Europe/Berlin');                       // → 03:30 local (gap: 'next')
zoned('2026-03-29T02:30', 'Europe/Berlin', { gap: 'reject' });    // → X_TIME_DST_GAP
```

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

- `Money = { minor: number; currency: string }`. **Never a float, never a bare number.**
- The currency travels with the amount, always.
- The minor-unit exponent comes from the ISO 4217 table — never assumed to be 2.
- Cross-currency arithmetic is **refused**, not silently coerced.
- Splitting money loses nothing.

```ts
const price: Money = { minor: 1999, currency: 'USD' };   // $19.99
add(price, { minor: 500, currency: 'USD' });             // ✅ { minor: 2499, currency: 'USD' }
add(price, { minor: 500, currency: 'EUR' });             // ✗ X_MONEY_CURRENCY_MISMATCH
fmt.money(price, { locale: ctx.locale });                // "$19.99"
```

### Enforcement

| Mechanism | Detail |
|---|---|
| Type-level | every arithmetic function takes `Money`, returns `Money`. There is no `number` overload to fall into |
| Currency check | runtime guard on every binary op → `X_MONEY_CURRENCY_MISMATCH` naming both currencies. Conversion is an explicit `convert(money, rate, to)` call with the rate as data |
| Lint rule `money-as-number` | a field named `*amount*`, `*price*`, `*total*`, `*fee*`, `*cost*` typed as `number` is a build error |
| Schema-level | the entity helper `money('price')` emits an integer column + a currency column and infers `Money` — a float column for money is a build error |
| Exponent table | `minorUnits('JPY') === 0`, `'USD' === 2`, `'KWD' === 3`, from the ISO table shipped in `@ultimat3/money`. Parsing and formatting both read it |
| Rounding | only at explicit boundaries, with a named mode (`half-even` default). No implicit rounding inside arithmetic — there is nothing to round, integers are exact |
| Allocation invariant | property test asserts `sum(allocate(total, ratios)) === total` for random totals and ratios, including negatives |
| Formatting | `Intl.NumberFormat` with `style: 'currency'` at the edge only; a `Money` is never string-formatted for storage or transport |

```ts
allocate({ minor: 1000, currency: 'USD' }, [1, 1, 1]);
// → [{minor:334},{minor:333},{minor:333}]  — largest-remainder, deterministic, sums to 1000
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
