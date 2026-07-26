# Theming

SCSS modules + design tokens. No Tailwind, no CSS-in-JS, no second CSS system. Build-time only, zero runtime.

Every colour is a semantic token. A raw hex in any component or stylesheet is a lint failure and fails `x verify` (check 2).

## Tokens

Named by **role**, not by value: `--color-bg`, never `--blue-500`. Stored as **space-separated RGB channels** so alpha composites cleanly.

| Token | Role |
|---|---|
| `--color-bg` | page background |
| `--color-bg-soft` | subtle zones, hovers |
| `--color-surface` | cards, sheets, popovers |
| `--color-fg` | body text |
| `--color-fg-strong` | headings, emphasis |
| `--color-fg-muted` | captions, placeholders |
| `--color-line` | borders, dividers |
| `--color-accent` | primary action, links |
| `--color-accent-strong` | hover/active of accent |

Nine tokens is the whole palette. A component that needs a tenth is asking for a design decision, not a variable.

## Defined once per theme

Light in `:root`, dark in the media query, both mirrored in `data-theme` overrides that beat the media query.

```scss
:root {
  --color-bg:            253 246 240;
  --color-bg-soft:       245 237 230;
  --color-surface:       255 255 255;
  --color-fg:             38  34  31;
  --color-fg-strong:      17  15  13;
  --color-fg-muted:      110 102  94;
  --color-line:          224 216 208;
  --color-accent:         34 122 197;
  --color-accent-strong:  21  92 152;
}

/* follow the OS when the user hasn't chosen */
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg:            18  18  20;
    --color-bg-soft:       28  28  32;
    --color-surface:       34  34  39;
    --color-fg:           228 226 222;
    --color-fg-strong:    248 247 245;
    --color-fg-muted:     150 146 140;
    --color-line:          54  54  60;
    --color-accent:        96 170 240;
    --color-accent-strong:130 190 248;
  }
}

/* explicit override beats the media query */
html[data-theme='dark'] {
  --color-bg:            18  18  20;
  --color-bg-soft:       28  28  32;
  --color-surface:       34  34  39;
  --color-fg:           228 226 222;
  --color-fg-strong:    248 247 245;
  --color-fg-muted:     150 146 140;
  --color-line:          54  54  60;
  --color-accent:        96 170 240;
  --color-accent-strong:130 190 248;
}
html[data-theme='light'] {
  --color-bg:            253 246 240;
  --color-bg-soft:       245 237 230;
  --color-surface:       255 255 255;
  --color-fg:             38  34  31;
  --color-fg-strong:      17  15  13;
  --color-fg-muted:      110 102  94;
  --color-line:          224 216 208;
  --color-accent:         34 122 197;
  --color-accent-strong:  21  92 152;
}
```

## Consuming tokens

Channels, not `#rrggbb`, so any opacity is `rgb(var(--token) / a)`.

```scss
/* apps/web/app/nav/toolbar.module.scss */
.toolbar {
  background: rgb(var(--color-bg) / 0.8);
  backdrop-filter: blur(12px);
  color: rgb(var(--color-fg));
  border-bottom: 1px solid rgb(var(--color-line));
}

.toolbar__action {
  background: rgb(var(--color-accent));
  color: rgb(var(--color-bg));

  &:hover { background: rgb(var(--color-accent-strong)); }
  &[disabled] { color: rgb(var(--color-fg-muted) / 0.6); }
}
```

No `dark:` variants, no `@media` in a component. A component is `bg` + `fg` + `line`; the theme flip happens above it.

## Where tokens live

| Path | Contents |
|---|---|
| `apps/web/shared/tokens/colors.scss` | the four blocks above — the only file with a hex value in the app |
| `apps/web/shared/tokens/space.scss` | spacing / radius / z-index scales |
| `apps/web/shared/tokens/type.scss` | font stacks, sizes, line heights |
| `apps/web/shared/tokens/index.scss` | forwards the rest; the single import for a surface entry |
| `apps/admin/shared/tokens/` | the admin's own copy, same nine roles → [Admin dashboard](Admin-Dashboard) |

`shared/` is importable by `site/`, `app/`, and `api/`. `site/` importing from `app/` stays a build error — see [Project layout](Project-Layout).

## Resolution and first paint

Order: **explicit `localStorage` choice → OS preference**. Applied by a blocking inline `<head>` script, before first paint, so there is no flash of the wrong theme.

```ts
export const THEME_STORAGE_KEY = 'theme';

export type Theme = 'light' | 'dark';

/** Inlined into <head> as a blocking script by the renderer. Runs before first paint. */
export function themeBootScript(): string {
  return `(()=>{try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');` +
    `var t=s==='light'||s==='dark'?s:` +
    `(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');` +
    `document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
}
```

| Concern | Rule |
|---|---|
| Persist | only when the user explicitly picks. `clearTheme()` removes the key and returns to OS-following |
| OS flip | a `matchMedia` change listener re-applies **only** when no explicit choice is stored |
| Determinism | `data-theme` beating the media query is what makes Playwright screenshots reproducible — set the attribute, don't emulate |
| SSR | the server never guesses a theme; it emits the boot script and neutral markup |
| No flash | the script is blocking and inline. An async or deferred theme script is a regression, not an optimization |

## Derived surfaces

| Surface | Derived from |
|---|---|
| PWA manifest `theme_color` | `--color-bg` of the light theme, resolved to hex at build time |
| PWA manifest `background_color` | same token, so the splash screen matches the shell → [PWA and offline](PWA-And-Offline) |
| `<meta name="theme-color">` | emitted twice, one per `prefers-color-scheme` media attribute |
| Maskable icon background | `--color-surface` |
| OG image background | `--color-bg`, `--color-fg-strong` for text |

The manifest is generated. Hand-editing a colour there drifts from the tokens and fails manifest freshness (`x verify` check 9).

## Accessibility

```scss
:focus-visible {
  outline: 2px solid rgb(var(--color-accent));
  outline-offset: 2px;
}

::selection {
  background: rgb(var(--color-accent) / 0.25);
  color: rgb(var(--color-fg-strong));
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

| Check | Enforcement |
|---|---|
| Contrast | AA (4.5:1 body, 3:1 large) for every `fg`/`bg` pair, **in both themes**, checked against the token table |
| Focus ring | `:focus-visible` from `--color-accent`; removing an outline without replacing it fails lint |
| Reduced motion | honored globally, not per component |
| Lighthouse a11y | minimum threshold in `app.config.ts`, default 95 → [Testing](Testing) |

## Rules

- Semantic tokens everywhere. A raw hex outside `shared/tokens/` is a lint failure.
- Each token defined once per theme: `:root`, the media query, and both `data-theme` mirrors.
- `html[data-theme]` always beats `prefers-color-scheme`.
- Theme applied before first paint by a blocking inline script.
- Nine colour roles. Adding a token is a design-system change, reviewed as one.
- Components never contain a media query for theme. They read tokens.
- Contrast verified in light **and** dark; a token pair that passes in one theme only is a failure.
- Colours are themed; numbers, dates, and money are localized → [I18n](I18n), [Money](Money), [Timezones and dates](Timezones-And-Dates).
