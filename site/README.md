# site/ — ultimate.developerz.ai

Static marketing + docs site. No framework, no bundler runtime, no dependencies, no network
requests at runtime. Built by `bun run site/build.ts`, deployed by `.github/workflows/pages.yml`.

## Build

```bash
bun run site/build.ts          # renders everything into site/dist/
bunx serve site/dist           # or any static server; clean URLs need index.html resolution
```

Output:

| Artifact | Source |
|---|---|
| `dist/index.html`, `dist/<slug>/index.html` | `pages/*.md` + `templates/*.html` |
| `dist/sitemap.xml` | every page, `lastmod` from the page's `updated` field |
| `dist/robots.txt` | allow-all + the sitemap reference |
| `dist/feed.xml` | RSS parsed from `pages/changelog.md` (`## <version> — <YYYY-MM-DD>`) |
| `dist/llms.txt` | copied from the repo root, so agents can fetch it from the site |
| `dist/csp.txt` | the exact `Content-Security-Policy` this build needs, with script + style hashes |
| `dist/assets/*` | copied verbatim |
| `dist/CNAME`, `dist/.nojekyll` | GitHub Pages custom domain, and "don't run Jekyll" |

The build fails loudly on its own SEO rules — a page with no title, no description, a
description outside 50–160 characters, or a title/description duplicated across pages stops the
build with an `X_SEO_*` message. The site is subject to the same rule as the framework: a
convention that isn't a build error doesn't exist.

## Local loop

```bash
bun run site/build.ts && open site/dist/index.html
```

There is no dev server and no watcher on purpose — a full build is ~50ms, so a rebuild is
cheaper than the machinery to avoid one.

## Files

```
build.ts                  # the one entry point: parse pages, fill templates, emit dist/
lib/config.ts             # origin, roots, PAGE_ORDER, STYLE_ORDER — shared by every stage
lib/text.ts               # escaping, slugs, {{var}} fills, frontmatter parsing
lib/markdown.ts           # the block + inline grammar the pages use
lib/highlight.ts          # local syntax highlighting, no dependency
lib/html.ts               # nav, table of contents, pager, JSON-LD
lib/seo.ts                # the title/description gate that fails the build
lib/feed.ts               # feed.xml, parsed back out of the changelog page
lib/assets.ts             # SCSS assembly, theme script, asset copying
templates/layout.html     # document shell: head, theme script, nav, footer
templates/home.html       # hero frame; {{hero_code}} is the first fenced block of index.md
templates/doc.html        # breadcrumb, article, TOC, pager
styles/tokens.scss        # semantic colour roles, both themes, RGB channels
styles/base.scss          # reset, typography, focus rings, reduced motion
styles/layout.scss        # header, doc shell, footer, bands
styles/components.scss    # cards, code blocks, tables, callouts, grids, the ladder
styles/syntax.scss        # highlight colours, themed for both schemes
scripts/theme.js          # the only JS: before-paint theme apply + delegated toggle
pages/*.md                # content, with frontmatter
assets/logo.svg           # mark + favicon, theme-aware via its own internal stylesheet
assets/og.svg             # 1200x630 social card
tsconfig.json             # this directory is a TS project, referenced by the root tsconfig
CNAME                     # ultimate.developerz.ai
```

`site/` is a project the root `tsconfig.json` references, so `bun run verify`'s `typecheck` step
covers it: a type error here is a red gate, exactly as it is in `packages/`. Its `paths` are empty
on purpose — the site is its own bundle graph (axiom 6), so no `@ultimat3/*` import can resolve
inside it. The build itself stays dependency-free and runs straight off the TypeScript sources.

## Authoring

Frontmatter, all required unless noted:

| Field | Meaning |
|---|---|
| `title` | `<h1>`, `<title>`, JSON-LD headline. Must be unique |
| `nav` | short label for the header, breadcrumb and pager |
| `menu` | `true` puts the page in the header nav (optional; everything is in the footer anyway) |
| `description` | meta description, OG and Twitter description. Unique, 50–160 chars |
| `lede` | one-sentence standfirst under the `<h1>` (optional; falls back to `description`) |
| `headline` | home page only: the `<h1>`, which differs from the `<title>` |
| `updated` | `YYYY-MM-DD`, used for `lastmod` and `dateModified` |

Page order — nav order, pager order, sitemap order — is the `PAGE_ORDER` array in `lib/config.ts`.
Adding a page means adding a file and one array entry.

Markdown supported: headings (`##`–`####`, auto-linked anchors), paragraphs, lists, GFM tables
(wrapped in their own scroll container), fenced code with `title="…"`, blockquotes, `---`, and
raw HTML blocks for the home page's grids. Callouts:

```text
::: warn one authz system
Body is normal markdown.
:::
```

`:::` accepts `ok`, `warn` or `info`, plus an optional label.

## The rules this site holds itself to

| Claim | How it is kept |
|---|---|
| **0kb JS baseline** | one inline script (~840 bytes) for the theme; nothing else ships. Every page works with JS off |
| **No network requests** | CSS is inlined, the font stack is the system stack, images are local SVG. No CDN, no Google Fonts, no analytics |
| **Dark + light** | semantic tokens as RGB channels; `html[data-theme]` beats `@media (prefers-color-scheme: dark)`; applied before first paint |
| **AA contrast in both themes** | every foreground/background pair, including syntax colours, is >= 4.5:1 |
| **No layout shift** | no webfont swap, no lazy-injected content, and every image carries intrinsic `width`/`height` |
| **No horizontal scroll** | wide tables and code blocks scroll inside their own container; grid children carry `min-width: 0` |
| **Keyboard + screen reader** | skip link, semantic landmarks, `:focus-visible` rings from tokens, `aria-current` on the active nav item |
| **Reduced motion** | `prefers-reduced-motion` collapses transitions and disables smooth scrolling |
| **SEO** | unique title + description, canonical, OG + Twitter, JSON-LD (`SoftwareApplication`, `TechArticle`, `BreadcrumbList`), sitemap, robots, RSS |

### Two deliberate exceptions

1. **`assets/*.svg` contain literal colours.** A standalone SVG used as a favicon or an OG image
   cannot read the page's custom properties, so each file carries its own internal stylesheet
   with a `prefers-color-scheme` block. Nothing in `styles/` contains a raw hex.
2. **`<meta name="theme-color">` carries a literal hex**, because the tag takes no CSS variable.
   Two tags are emitted, one per scheme.

`og.svg` is an SVG. Some social platforms rasterise only PNG/JPEG — if the card matters for a
launch, render it once (`resvg og.svg -o og.png`) and point `og_image` in `build.ts` at the PNG.

## Deploy

GitHub Pages, from `.github/workflows/pages.yml` (owned by another part of the repo):

```yaml
- run: bun run site/build.ts
- uses: actions/configure-pages@v6
  with: { enablement: true }
- uses: actions/upload-pages-artifact@v5
  with: { path: site/dist }
```

`CNAME` pins `ultimate.developerz.ai`; `.nojekyll` stops Pages from filtering files. Serving it
anywhere else needs nothing but a static file server — every URL is a real directory with an
`index.html`.

If you front it with a server you control, apply the CSP the build computed:

```bash
cat site/dist/csp.txt
```
