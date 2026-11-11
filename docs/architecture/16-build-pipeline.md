# Build pipeline

How source becomes a served document. `As of 2026-08`.

Companion to [`09-rendering-internals.md`](./09-rendering-internals.md), which covers the five modes. This page covers what compiles the source those modes render.

## One path, four entry points

`x dev`, `x build --target static`, `apps/web/server.ts` and `bun test` all load a page module the same way. There is no "bundled" behaviour separate from "dev" behaviour for a page, because a page is never bundled — only islands are (below).

```
import '@ultimat3/render/server' → installRenderLoader() (module-loader.ts)
  Bun.plugin onLoad /\.tsx$/   → Bun.Transpiler(jsx: react, jsxFactory: __xh)
                                 + `import { h as __xh, Fragment as __xFragment }`
  Bun.plugin onLoad /\.s?css$/ → sass.compileString → scoped class map + CSS registry

loadApp()                      → import(page.tsx) → module.config  → registerRoute
                                                  → pageComponentOf → entry.component

routeDocument(entry, data)     → renderHead(headFromMeta(await config.meta(data)))
                               + <link rel=stylesheet href=/styles/<hash>.css>
                               + <div id="x-root">{ await renderComponent(entry.component) }</div>
```

| Stage | File | Owns |
|---|---|---|
| loader install | [`packages/render/src/module-loader.ts`](../../packages/render/src/module-loader.ts) | the two `Bun.plugin` hooks, the stylesheet registry, `stylesFor` |
| JSX factory | [`packages/render/src/jsx.ts`](../../packages/render/src/jsx.ts) | `h`, `Fragment`, `JsxNode` — inert nodes, no DOM, no reactivity |
| HTML writer | [`packages/render/src/render-html.ts`](../../packages/render/src/render-html.ts) | the tree walk, escaping, `await`ing async components |
| escaping | [`packages/render/src/html.ts`](../../packages/render/src/html.ts) | the one escaper, the attribute table, void elements |
| SCSS | [`packages/render/src/css-modules.ts`](../../packages/render/src/css-modules.ts) | `sass` + the class-scope rewrite + bare-specifier resolution |
| which export is the page | [`packages/render/src/route-component.ts`](../../packages/render/src/route-component.ts) | `Page` → single `…Page` → single capitalised function |
| the document | [`packages/cli/src/runtime-render.ts`](../../packages/cli/src/runtime-render.ts) | head + style + body, per mode |
| measured budgets | [`packages/cli/src/budgets.ts`](../../packages/cli/src/budgets.ts) | `measureJsBytes` over the emitted HTML, `.x/build-stats.json` |

**`BUILD_STATS_RULES` is a version, and bumping it is a maintainer's edit.** `.x/build-stats.json`
records the rules that wrote it (`measuredBy`), and the `budgets` step reads only a file stamped
with the current `BUILD_STATS_RULES` (`packages/cli/src/budgets.ts`). A stale file is
`X_BUDGET_UNMEASURED`, never a number. **Bump it in the same change as anything that alters what a
budget charges**: a script added to or removed from `FRAMEWORK_SCRIPTS` or
`FRAMEWORK_INLINE_SCRIPTS`, a tag kind excluded, a framework script decided charged. Otherwise a
file written under the old rule is read as a measurement of the new one. `.x/` survives upgrades,
and that is how the reference app was charged 250 B for `/x-sw-register.js` after it was exempted.
`2` is that exemption, plus the decision to **charge** the page boot: it ships only on a page that
hydrates something, so it is part of the interactivity the app opted into. **The bump is a build
error**: `RULES_PIN` in `packages/cli/src/budgets.test.ts` pins `{ rules, fingerprint }`, the
fingerprint hashing `FRAMEWORK_SCRIPTS`, `FRAMEWORK_INLINE_SCRIPTS` and which `<script type>` kinds
are charged. Moving any of them without `BUILD_STATS_RULES` fails the `unit` step, naming the bump.
What it cannot see: a decision that changes no set — charging a script that was already charged by
default, as the page boot was — so that half of a bump stays a maintainer's call.

## Why the loader installs on import

`Bun.plugin` only transforms modules loaded **after** it, so the install is a module-scope side effect of [`packages/render/src/server.ts`](../../packages/render/src/server.ts) — every consumer that will load a `.tsx` route (`x dev`, `x build`, `server.ts`, a test that `await import()`s a page) imports `@ultimat3/render/server` before the source it loads. Any later hook would be four places one fact can be wrong instead of none.

It sat on `packages/render/src/index.ts` until 9.0.0, which is what the `.` / `./server` split moved. Importing **`@ultimat3/render` no longer installs anything**: the client barrel bundles for a browser, and the loader pulls `sass` and `node:url`, whose browser polyfill exports neither name `css-modules.ts` asks for.

## Why a runtime transform instead of `tsconfig`

`tsconfig.json` sets `jsx: "preserve"` with `jsxImportSource: "solid-js"`, and Bun's own compile of that is wrong on every Bun. Through 1.4.2 Bun read `preserve` as "no automatic runtime" and fell back to the **classic** `React.createElement` factory, ignoring `jsxImportSource` — so every `.tsx` in the repo compiled to a reference to a global `React` that does not exist, and any component call threw `ReferenceError`. That was invisible because nothing ever called one. From 1.4.3 Bun honours `jsxImportSource` and imports `jsxDEV` (`jsx` in production) from `solid-js/jsx-dev-runtime`, which solid-js maps to a module exporting no such name: a link-time `SyntaxError` in every graph that merely imports a component (issue #883, measured on 1.3.14 and 1.4.3). Solid ships no runtime factory because its JSX is a compile-time contract.

So every graph that loads a `.tsx` installs a transform, and there are exactly three: the runtime loader (`installRenderLoader`, which both test preloads install before the first file), `serverTsxBuildPlugin` for a `Bun.build` of server code (the compiled `x`, module-graph measurements), and the island build's `solidJsxPlugin` for a browser graph.

Both halves of the config stay as they are, and each now means one thing:

| Setting | What it is for |
|---|---|
| `jsxImportSource: "solid-js"` | the JSX **type** namespace — `class` not `className`, Solid's element attribute types |
| the loader's `jsxFactory` | the **runtime** factory, which is the framework's and which an app never configures |

## What is not here

- **No page bundle; islands only.** A page module is never bundled for the browser — the server
  renders it through the inert `h` above. What the browser gets is one `Bun.build` entry point per
  `*.island.tsx` (`packages/cli/src/island-bundle.ts`), minified, Solid-compiled by
  `babel-preset-solid` inside that build's plugin (`packages/cli/src/solid-loader.ts`), named by a
  hash of its final bytes (`As of 2026-11`, #1075: a source hash kept one URL for two byte strings
  when the minifier renamed a shared chunk's exports). `As of 2026-10`, this replaced the 2026-08 statement that `Bun.build`
  was called nowhere.
- **Islands are grouped by route** (`packages/cli/src/island-groups.ts`, `As of 2026-11-10`).
  Islands rendered on exactly the same set of routes are one split build sharing their modules as
  chunks; every other island — one route's only island, the layout-wide banner, an island no page
  names — is built alone, splitting off, byte for byte what it was. `islands: { sharedChunks: true }`
  is one group holding every island; off by default, by measurement
  (`packages/core/src/config-islands.ts`). The groups are read from the **page sources** — each
  `page.tsx`'s `*.island.tsx` string literals, comments stripped, resolved from the page's directory
  — not from a render or the route registry: `x dev`, the container, the image's island store and
  the static export all build islands before (or without) rendering, and `dev-rebuild.ts` builds
  them in parallel with the app load, so a source read is the one input every caller has and gives
  one grouping per tree. A literal it misses only leaves that island alone, which is the old
  behaviour. Each eagerly booted island's shared chunks are `<link rel="modulepreload">`ed
  (`route-islands-preload.ts`).
- **A group's output is reused while its inputs are unchanged** (`packages/cli/src/island-group-cache.ts`,
  `As of 2026-11-10`): `.x/cache/islands/<key>.json`, the key the group, its splitting, the
  framework and Bun versions, the environment (`bun.lock`, each root/`apps/*` `package.json` and
  `tsconfig.json` with its relative `extends`) and the app's realtime answer; the entry holds the
  digest of every file the build read (the bundler's inputs, a linked framework package's
  included, and every Sass partial a sheet `@use`s; `node_modules` left to the lockfile) and of
  each directory listing an import resolved in, all rehashed before use, plus each chunk's own
  hash. Entries untouched for 14 days are swept. Same bytes, same URLs, same layout in `x dev`,
  `x build` and the image — a restart rebuilds only the groups an edit reached. On the 159-island
  bench app: islands 14.6–21 s built, 0.42 s reused, 0.8 s with one island edited.
- **Hydration is per island, never per page.** An island mounts with Solid's own runtime when its
  `hydrate` timing fires; the page shell around it is server HTML and is never hydrated. There is
  still no whole-page client graph, by design (axiom 6: the static path never pays for the app
  path).
- **`<Hole>` splits a `stream` page.** `renderToHtml` with a `holes` sink emits `holeMarker()` and collects the subtree; `renderStreamHtml` splices each `<x-hole>` chunk in completion order. Every other render passes no sink, so a hole is its children, awaited inline: `budgets` weighs a hole's island. Solid's own boundary component must not be reached for: it calls `getContextId()`, which throws `cannot be used under non-hydrating context` outside a Solid renderer.
- **No per-module CSS graph.** `stylesFor(surface)` filters by the stylesheet's own path, which keeps `site/` and `app/` apart but does not attribute CSS to a single route. So a route links its whole surface's sheet — which is the remaining half of the 2026-09-06 fix: the bytes are now cached rather than re-sent, but a dashboard still downloads the terminal's rules once.

## What is compressed

`As of 2026-11`. The container gzips, because axiom 7 rules out assuming an edge: the `compress` stage ([`packages/http/src/compress.ts`](../../packages/http/src/compress.ts)), last in the pipeline, level 6, no option. The rule is one conjunction, and a response that fails it is handed back as the same object with its body unread.

| Condition | Why |
|---|---|
| `GET` or `HEAD`, status `200` | no 206 or 304. A HEAD carries GET's coded headers and no body (RFC 9110 §9.3.2) |
| `accept-encoding` names `gzip` with q above 0 | RFC 9110. A `*` is not read as gzip |
| no `content-encoding`, no `content-range` | a handler's own coding stands |
| `cache-control` has no `private`, `no-store`, `no-cache`, `no-transform` | BREACH: a private document reflects a secret beside attacker input. `stream` mode is always `private, no-store`, so it never buffers. `no-cache` is the one spelling that survives the `cache-headers` review on a signed-in answer |
| `content-type` essence on the list in `compress.ts` | text, JSON, SVG, XML, VTT. Never `text/event-stream`; images and fonts are already coded |
| the caller is anonymous, or `cache-control` says `immutable` | BREACH again: `stale-while-revalidate=60` alone offers nothing and withholds nothing, so the `cache-headers` review leaves it, and the body is still the visitor's |
| `content-length` declared, 1,024 to 262,144 | below, the header overhead wins. Above, `gzipSync` holds the loop: measured 2026-11-03, level 6, high-entropy text, 2.35 ms at 256 KiB against 9.58 ms at 1 MiB (about 29 ms at 1 MiB on the security audit's machine, about 34 anonymous req/s per core). Undeclared is unknown: never read |

| Declares its length | Does not |
|---|---|
| `html`, `textResponse`, `jsonResponse`; the stylesheet, island, worker, `sw.js`, register-script, manifest, `robots.txt` and sitemap routes; `revalidatedResponse`; a whole `asset()` file | `stream`, a `new Response(...)` that does not set it. `packages/cli/src/declared-length.test.ts` fails on a public framework route of a coded type that does not declare |

- **Coded answer**: `content-encoding: gzip`, its own `content-length`, no `accept-ranges`, a strong `etag` weakened to `W/`. `notModified` strips the `W/` when it comes back.
- **`vary: accept-encoding`** on every answer that passes the type and cache rows, coded or not, so a shared cache cannot hand a coded body to a client that refused it.
- **The read is counted and timed.** A stream past its declared length, a failing one, or one still reading at `ctx.signal` goes out identity and whole, `http.compress_failed` logged with `reason`. So does a `gzipSync` throw. Compression never fails a request.
- **No brotli**: 5% over gzip on the reference app (183,536 B against 193,291 B) for a `node:zlib` dependency. **No memo**: 1.4–2.9 ms per gzip of the largest stylesheet against nothing measured that asks for a second cache.
- **`budget.js` is unchanged**: it bounds parse cost, not transfer.

## What reaches the document, in what order

`As of 2026-08`. `stylesFor(surface)` emits **globals first, then modules**, and includes the
surface's own sheets plus every `surface === null` (a package sheet) and `shared/` one.

`As of 2026-09-06` that string is not in the document: `@ultimat3/cli`'s `style-bundle.ts`
content-hashes it into `/styles/<hash>.css` (surfaces whose CSS is identical share one file), the document carries a
`<link rel="stylesheet">` in `<head>` — still render-blocking, so nothing flashes unstyled — and
the file is served `public, max-age=31536000, immutable`. `writeStyles` puts it in a static
export, so the artifact stays self-contained.

Two bugs lived in the gap between that sentence and the code, and both were invisible until a page
was opened in a browser:

| Was | Cost |
|---|---|
| `packages/ui/src/global.scss` — "one import for an app document shell" — was imported by **nothing, anywhere** | no `:root` block reached any document, so every `var(--color-*)` and `var(--space-*)` resolved to nothing and the whole token layer was dead in every app ever deployed |
| `stylesFor` dropped `surface === 'shared'` | a stylesheet in the one directory both graphs import was filtered out of both documents |
| insertion order, not globals-first | the reset could lose a specificity tie to whichever page module happened to load first |

The global layer arrives through the **app's own module graph** — `apps/web/shared/global.scss`
(`@use '@ultimat3/ui/global.scss'`) plus a one-line `shared/global.ts` that imports it — because
`render` is tier 4 and `ui` is tier 5, so no framework package may pull it in. `x new` writes both,
and `x verify`'s `budgets` step fails with `X_STYLES_GLOBAL_MISSING` when a rendered document
carries CSS and defines no `:root` custom properties.

`shared/global.ts` must be reached by a **dynamic** import (`loadApp`'s glob already is one): Bun
resolves a file's entire static graph before evaluating the module that installs the `.scss`
plugin, so a static import would compile the stylesheet with no loader in place.
