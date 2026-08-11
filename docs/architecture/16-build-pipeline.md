# Build pipeline

How source becomes a served document. `As of 2026-08`.

Companion to [`09-rendering-internals.md`](./09-rendering-internals.md), which covers the five modes. This page covers what compiles the source those modes render.

## One path, four entry points

`x dev`, `x build --target static`, `apps/web/server.ts` and `bun test` all load a page module the same way. There is no "bundled" behaviour separate from "dev" behaviour, because there is no bundler.

```
import '@ultimat3/render'      → installRenderLoader()   (module-loader.ts)
  Bun.plugin onLoad /\.tsx$/   → Bun.Transpiler(jsx: react, jsxFactory: __xh)
                                 + `import { h as __xh, Fragment as __xFragment }`
  Bun.plugin onLoad /\.s?css$/ → sass.compileString → scoped class map + CSS registry

loadApp()                      → import(page.tsx) → module.config  → registerRoute
                                                  → pageComponentOf → entry.component

routeDocument(entry, data)     → renderHead(headFromMeta(await config.meta(data)))
                               + <style>stylesFor(entry.surface)</style>
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
| the document | [`packages/cli/src/dev-render.ts`](../../packages/cli/src/dev-render.ts) | head + style + body, per mode |
| measured budgets | [`packages/cli/src/budgets.ts`](../../packages/cli/src/budgets.ts) | `measureJsBytes` over the emitted HTML, `.x/build-stats.json` |

## Why the loader installs on import

`Bun.plugin` only transforms modules loaded **after** it. Every consumer that will load a `.tsx` route imports `@ultimat3/render` first — a route file's first import is `defineRoute` — so `packages/render/src/index.ts` installs it at module scope. Any later hook (`x dev`, `x build`, `server.ts`, a test preload) would be four places one fact can be wrong instead of none.

## Why a runtime transform instead of `tsconfig`

`tsconfig.json` sets `jsx: "preserve"` with `jsxImportSource: "solid-js"`. Bun reads `preserve` as "no automatic runtime" and falls back to the **classic** `React.createElement` factory, ignoring `jsxImportSource` — so every `.tsx` in the repo compiled to a reference to a global `React` that does not exist, and any component call threw `ReferenceError`. That was invisible because nothing ever called one.

Both halves of the config stay as they are, and each now means one thing:

| Setting | What it is for |
|---|---|
| `jsxImportSource: "solid-js"` | the JSX **type** namespace — `class` not `className`, Solid's element attribute types |
| the loader's `jsxFactory` | the **runtime** factory, which is the framework's and which an app never configures |

## What is not here

- **No client bundle.** `Bun.build` is called nowhere. No chunks, no splitting, no `modulepreload`, no minification outside `--target binary`.
- **No hydration.** `solid-js@2.0.0-experimental.16` ships the reactivity core only: no `solid-js/web`, so no `render`, `hydrate`, `renderToString`, `template` or `ssr`, and `solid-js/jsx-runtime` exports types and no factory. `hydrate.ts` and `islands.ts` emit the markup conventions a client runtime would read; nothing reads them yet.
- **No `<Suspense>` holes.** `renderStreamHtml` still splices `<x-hole>` chunks, but nothing marks a subtree as one, so a `stream` route flushes its whole body in the first chunk — correct output, no streaming benefit.
- **No per-module CSS graph.** `stylesFor(surface)` filters by the stylesheet's own path, which keeps `site/` and `app/` apart but does not attribute CSS to a single route.
