# 🖼 @ultimat3/render

The `route` primitive and the four render modes.

| Mode | Behavior | Use |
|---|---|---|
| `static` | built once, served as a file | marketing, docs |
| `isr` | static + background regen on tag/TTL | catalogs, profiles |
| `ssr` | per-request full render | fresh SEO pages |
| `stream` | static shell flushed instantly, holes streamed | **default for app pages** |

```ts
export const config = defineRoute({
  render:     'isr',                  // static | isr | ssr | stream
  revalidate: { tags: [tag.post] },
  prerender:  () => db.posts.slugs(),
  offline:    'precache',             // precache | runtime | network-only
  hydrate:    'visible',              // idle | visible | interaction | never
  budget:     { js: '40kb', lcp: 2000 },
  load:       ({ params }) => db.posts.bySlug(params.slug),   // once per render
  meta:       ({ data, url }) => ({ title: data.title, description: data.excerpt,
                                    og: { image: data.cover }, canonical: url,
                                    ld: ld.Article(data) }),
});

export function Page(props: { data: Post }) { /* the SAME object meta was given */ }
```

## `load` is the one server-side data seam

Optional, and the only way a page gets data. It runs **once per render** and the result is handed
to both `meta` and the page component — the same object, never two resolutions, because a `<title>`
describing content the body does not contain is the failure this seam exists to prevent.

`meta` receives a context, not the bare data: `{ data, params, url, t }`. All four are needed for a
real `<head>` — the data for the content, `url` for the canonical, `t` because no user-facing
string may be hardcoded. A route that declares no `load` still gets `params` and `url` under the
same names it always had, so nothing that shipped has to change.

`As of 2026-07`, omitting `load` means the context IS the data: `meta` may read only what the
context supplies, and anything richer is a compile error naming the missing `load`.

```text
defineRoute({ /* … */ meta: ({ data }) => ({ title: data.post.title }) });
// Property 'load' is missing in type … but required in type '{ readonly load: RouteLoadFn<…> }'
```

A `text` fence, not a `ts` one, because it is the one example in this file that must **not**
compile — that is the whole claim. Without the rule the route compiled and rendered `undefined`
in a `<title>`.

A loader that throws is `X_ROUTE_LOAD_FAILED`, naming the path to fix — unless it threw an
`UltimateError` of its own, which passes through untouched: a policy denial or a missing row
already carries a better code and a better fix than any wrapper could. Membership is the framework's
brand, not a `code` property: an `ENOENT` is an `Error` with a string `code` too, and it gets
wrapped like any other loader failure.

## `offline` and `meta` are required by the type

Not by a lint rule, not by a doc — by `RouteDefinition`. Axiom 3 lives in the type system:
a route that forgets its offline strategy or its `<head>` does not compile. `defineRoute`
re-checks both at runtime (`X_ROUTE_OFFLINE_MISSING`, `X_ROUTE_META_MISSING`) for JS callers
and generators.

`hydrate` was the third, and is not, `As of 2026-08`. It is the one key the framework can work
out from the page's own declarations — see the island section — and requiring a value it already
knows is not enforcement, it is a second place to get one thing wrong.

## `defineRoute` returns a descriptor, not the object you passed

Two fields come back narrower than they went in, so nothing downstream branches on shape:

| Field | The declaration accepts | The descriptor always is |
|---|---|---|
| `meta` | `(ctx: RouteMetaContext) => RouteMeta \| Promise<RouteMeta>` | `(ctx) => Promise<RouteMeta>` |
| `budget` | omitted, or a `RouteBudget` | a `RouteBudget` — `{}` when undeclared |
| `hydrate` | omitted, or a `HydrateStrategy` | a `HydrateStrategy` — derived from the islands |
| `islands` | never written | the `IslandSpec`s this module declared, in order |

`meta` takes the **context**, never the bare data — the same `{ data, params, url, t }` the
declaration receives, all four required:

```ts
import type { RouteConfig, RouteMetaContext } from '@ultimat3/render';

declare const config: RouteConfig<Post>;
declare const ctx: RouteMetaContext<Post>;   // { data, params, url, t }

const meta = await config.meta(ctx);   // always. sync or async declaration, one call
const js = config.budget.js ?? null;   // never config.budget?.js
```

No author is forced to write `async`, and a `meta` that throws synchronously comes back as
a rejection, so one `catch` covers both. The budget's *fields* stay optional:
`budget.js === undefined` still means "declared no JS budget", which is exactly what fails
a hydrating `site/` route below.

## Mode invariants, checked at registration

| Mode | Invariant | Error if violated |
|---|---|---|
| `static` | no per-request state — no `policy`, no `revalidate` | `X_ROUTE_MODE_INVALID` |
| `isr` | needs a trigger: `revalidate.tags` or `revalidate.ttl`; **no `policy`** — one cached document per URL cannot answer two actors | `X_ROUTE_MODE_INVALID` |
| `ssr` | cannot be prerendered | `X_ROUTE_MODE_INVALID` |
| `stream` | at least one `<Suspense>` boundary | `X_ROUTE_MODE_INVALID` |

Plus surface rules: `site/` allows `static | isr | ssr`, `app/` allows `stream | ssr`,
`api/` renders nothing, and a `site/` route that opts into hydration without a `budget.js`
is a build error.

## The route table is the single source of route truth

`registry.ts` maps file paths to URLs and `describeRoutes()` projects the table into a
sorted, JSON-safe descriptor list. Every downstream generator reads that one table.

| File | URL |
|---|---|
| `site/page.tsx` | `/` |
| `site/pricing/page.tsx` | `/pricing` |
| `site/(marketing)/about/page.tsx` | `/about` |
| `site/blog/[slug]/page.tsx` | `/blog/:slug` |
| `site/docs/[...path]/page.tsx` | `/docs/*path` |
| `app/dashboard/page.tsx` | `/dashboard` |
| `api/posts/route.ts` | `/api/posts` |

The URL is the **directory** path under the surface; the filename names the kind of file, never a
URL segment. One spelling per surface — `page.tsx` under `site/` and `app/`, `route.ts` under
`api/` — and `registerRoute` refuses anything else with `X_ROUTE_FILE_INVALID`. `index.tsx` is not
a page. Two spellings would make "is this file a route?" undecidable for the module scan, the
boundary walk, `sw.js` and the author reading the folder; one spelling also co-locates
`page.tsx` + `page.module.scss` + `page.test.ts`, and gives `[slug]/` its own stylesheet.

Consumers: `x.manifest.json`, the `/_x` routes panel, `sitemap.xml`, `sw.js`
(`@ultimat3/pwa` takes descriptors as data — tier 4 packages never import each other).

## `site/` cannot import `app/` — build error, resolved transitively

```
X_SURFACE_BOUNDARY: site/ imported app/
  cause: site/pricing/page.tsx → shared/ui/button.tsx → app/charts/sparkline.tsx
  fix:   x fix boundary site/pricing/page.tsx   (or move sparkline out of shared/ui)
```

The failure this prevents, in order:

1. Someone puts `<Button>` in `shared/ui/` — correct, both surfaces need buttons.
2. A dashboard needs a button with an inline trend line, so `<Sparkline>` joins the same
   file and pulls in the charting library.
3. `site/pricing` imports `<Button>`.
4. The highest-intent page in the product now ships chart.js. Nothing broke, nothing
   warned, LCP regressed 900ms, discovered a quarter later by a Lighthouse audit nobody
   scheduled.

The import that costs you is three hops from the file anyone reviewed, so
`checkSurfaceBoundary()` walks the whole value-import graph. `import type` edges are erased
at build time and therefore never carry the boundary. `shared/` is a leaf; `app/ → api/` is
types-only.

## One interactive component on a static page

`island()` — a marketing page with a contact modal, a docs page with a search box, a pricing page
with a plan toggle. The page stays `render: 'static'`; the modal is the only JavaScript on it.

```tsx
const ContactModal = island({ src: './contact-modal.island.tsx', props: ['subject'] });

export const config = defineRoute({
  render: 'static', offline: 'precache',
  meta: ({ t }) => ({ title: t('pricing.title'), description: t('pricing.description') }),
});

export function Page() {
  return <main><h1>Pricing</h1>
    <ContactModal subject="pricing"><button>Contact us</button></ContactModal>
  </main>;
}
```

### Declaring the island is the whole declaration

That route says `render` and `meta` and nothing else, and it is the same route that used to spell
out three things. `hydrate` and `budget.js` are **derived from `island()`**, `As of 2026-08`:

| Omitted | Derived | Overridden by |
|---|---|---|
| `hydrate` | `'interaction'` when the module declared an island, `'never'` when it did not | stating `hydrate` — the only way to say `idle` or `visible` |
| `budget.js` | the surface baseline + 20kb (`site/` → `20kb`, `app/` → `34kb`) | stating `budget: { js }` |

Both were required and both were punished: an island on a route still at `'never'` is
`X_ISLAND_NOT_HYDRATED`, and a `site/` route off `'never'` with no `budget.js` is refused at
registration. Two failures for one omission the `island()` call above had already answered.

20kb because a Solid island cannot cost less. Measured through `buildIslands`, minified, against
production Solid, `As of 2026-08`:

| Island | Bytes |
|---|---|
| `render(() => <p>hello</p>, el)` — the floor, before an author writes a line | 12,588 |
| a signal, a button and reactive text | 13,663 |
| `settings.island.tsx`, the heaviest island this repo ships | 17,797 |
| one directive's hydration runtime at `hydrate: 'idle'` | 774 |
| the same at `'interaction'`, which is what an island route declaring no `hydrate` gets | 1,251 |

17,797 + 1,251 = **19,048** — the heaviest island this repo ships, plus the runtime an app pays
without writing a number down. `DEFAULT_ISLAND_HYDRATE` is `'interaction'`
([`route.ts:33`](src/route.ts)), applied at `:253` to any island route that states no `hydrate`, so
`idle`'s 774 is the cheaper case and not the one a budget has to clear.

The default is **20,480** (20kb), which is not that number rounded: the next whole kilobyte above
it is 19,456, and clearing today's worst island by 408 bytes is a ceiling the next line anyone
writes breaks. 20kb leaves 1,432 B, and stays under 2× 19,048 — so a route that bundles the same
island twice is still refused. All three clauses are assertions in
[`island-budget.test.ts`](src/island-budget.test.ts)'s `DEFAULT_ISLAND_JS_BYTES` block, against the
measured table above; a default that stopped clearing the floor, or stopped being a ceiling, is red.

It was **4kb** until `As of 2026-08`, sized from `contact-sales.island.tsx` — 875 B of chunk, and
no `solid-js` import anywhere in it. Calibrating a JSX budget on the one island shape that does not
pay the JSX runtime put the default a factor of three below the floor of every island that does:
no `budget.js` under 4096 was reachable on any surface, because the allowance is measured ABOVE the
baseline and not against it. (Its second number was wrong too — one directive's hydration runtime
was 615 B at `idle` and 881 B at `interaction` when that default was set, never 1,019. The table
above is what it measures today: the runtime has grown three times since, for the mount markers,
for terminating the chain `boot` starts, and for aiming the replay.)

Still a ceiling and not a pass: exceeding it is `X_BUDGET_EXCEEDED`, naming the island. An island
that pulls a design system in — `@ultimat3/ui`'s `<Switch>` measures 36,335 B — writes its own
number down, which is the point of the field.

`island()` goes **above** `defineRoute`, where JavaScript already puts a `const` the page uses:
`defineRoute` drains the declarations made before it. Below it, the route resolves to `'never'` and
the render fails loudly with `X_ISLAND_NOT_HYDRATED`, whose fix names both repairs.

An island still declares no strategy of its own. One spelling for "this route hydrates" — the
route's — because two islands wanting different timings would leave `RouteDescriptor.hydrate`, which
`sw.js`, the web manifest and `x routes` all read, with no single true answer.

| The route says | The island says |
|---|---|
| `hydrate` — WHEN it wakes, once, for the whole route, and only when the default is wrong | `src` — WHICH module, and `props` — what it may receive |
| `budget.js` — how many bytes that is allowed to cost, when 20kb is not the number | `tag`, `events`, `rootMargin` — how the wrapper behaves |

### An island node is a JSX child

`island()` returns a component, and `<ContactModal />` is an ordinary element call. That took work:
an app types its JSX with `jsxImportSource: solid-js`, whose `JSX.Element` is a type **alias** —
unaugmentable — and whose only object-shaped member is `ArrayElement`. `IslandNode` is therefore a
branded (empty) array, which is what makes it assignable. Until `As of 2026-08` it was a plain
object and every `<ContactModal />` in an app was **TS2786**, so the feature was reachable only
through `h(ContactModal, …)` — which is exactly what the framework's own tests used, and why
nobody saw it. `type-pins.tsx` holds the claim now: it writes the JSX an author writes, and `tsc`
reads it.

### Declared by specifier, never by import

`src` is a string. The page never imports the client module, so:

- **there is no import edge** for the bundler or `checkSurfaceBoundary()` to follow from
  `page.tsx` into the island — the static page's graph cannot grow the island's dependencies;
- **the component cannot close over anything.** A string does not capture a database handle,
  a request, an actor or a row. There is no scope to leak.

`.island.tsx` is the one spelling, for the reason `page.tsx` is: a file ships to the browser if
and only if its name says so, decidable by `grep` and by the bundler without opening it. Anything
else is `X_ISLAND_INVALID`, and the fix is the `git mv`.

### Props are the only channel, and they are checked

| Rule | Failure |
|---|---|
| every prop is declared in `props: [...]` | `X_ISLAND_PROPS_INVALID`, naming each undeclared key |
| every value is JSON — no function, `Date`, class instance, `bigint`, `undefined`, cycle | `X_ISLAND_PROPS_INVALID`, naming the path and the type |
| serialized props ≤ `ISLAND_PROPS_MAX_BYTES` (4096) | `X_ISLAND_PROPS_INVALID`, naming the measured size |

`<ContactModal {...post} />` fails and names `email`, `passwordHash` — every column the spread
would have shipped. The type refuses it first (`type-pins.tsx` pins that); the render refuses it
second, which for `static` and `isr` is build time. `children` are the server-rendered shell and
are never serialized.

### It counts against the route's budget

```ts
const collector = createIslandCollector({ file, hydrate: config.hydrate, resolve });
const html = await renderToHtml(page, { islands: collector });
document.body += hydrateRuntime(collector.directives);   // the one thing left to remember
```

Declaring an island is what puts a `budget.js` on the route — `defaultIslandBudget(surface)`,
applied by `registerRoute`, so a page that declares one is charged without saying so. **Weighing it
is `x verify`'s `budgets` step**, which measures the emitted document against the manifest's
per-route budget and fails with `X_BUDGET_EXCEEDED`.

**Removed `As of 2026-08-23`** (breaking): `routeJsBytes`, `graphFor`, `checkBudget`, `checkBudgets`, `assertBudget` and
the `Island` / `BundleGraph` / `RouteBytes` / `BudgetReport` types. They were a second, graph-based
answer to the same question that nothing in the framework ever asked — the gate has always been the
CLI's. `parseByteBudget` (the `'40kb'` grammar) and `defaultIslandBudget` stay.

`entry.islands` is filled from `config.islands` at registration and from nothing else, so a declared
island is on the record even on a route no render has touched. It was `input.islands ?? []` and
nothing ever passed `islands`; `RegisterRouteInput` no longer carries the key, because the only
thing a caller could do with it was un-declare an island.

An island on a route that resolves to `hydrate: 'never'`, or rendered with no collector, is
`X_ISLAND_NOT_HYDRATED` — inert markup either way. With `hydrate` derived it means one of exactly
two things, and the `fix:` names **the one that is yours**: the route stated `'never'` next to an
island (remove it), or the `island()` call sits below the `defineRoute` that would have drained it
(move it up). The throw site tells them apart by asking whether that declaration is still waiting to
be drained. A `'never'` route is also left with no derived budget, deliberately — a ceiling there
would paper over the contradiction.

### "Booted" and "mounted" are different facts, and the DOM says which

| In the DOM | Means |
|---|---|
| `data-x-island`, `data-x-hydrate` | **declared** — emitted for every island, `'never'` included |
| `el.__x` set, neither marker | **importing** — the chunk was requested, `mount()` has not settled |
| `data-x-mounted=""` | **running** — `mount()` resolved |
| `data-x-failed="<message>"` | **threw** — `mount()` rejected, and this is why |

`el.__x` is assigned when `import()` is *called*, so on its own it cannot tell a chunk still
downloading from one whose `mount()` threw — and the second is the half that gates a deploy. Both
markers are set by the runtime, never by `emitIslandAttributes`: the server does not know the
answer. A rejection still rethrows, so `el.__x` stays rejected and the `interaction` replay queue is
never flushed into an island that did not mount. `ISLAND_MOUNTED_ATTRIBUTE` and
`ISLAND_FAILED_ATTRIBUTE` are exported so a reader (`x shot`, an app's own test) names them once.

`IDLE_HYDRATE_TIMEOUT_MS` (2000) is the `requestIdleCallback` deadline the `idle` runtime is built
from, exported for the same reason: anything waiting for hydration has to wait at least this long,
and a second copy of the number is a settle that shoots early and calls a healthy page broken.

## Two entry points

**Split 2026-08-22, and every claim in this section holds `As of 2026-08`.**

`@ultimat3/render` is the **client** half — the `route` primitive, the JSX factory, islands,
hydration, `<head>`, the route table. It bundles for the browser, and
`scripts/browser-barrel.test.ts` builds it that way and asserts it.

`@ultimat3/render/server` is the **build-time** half — the `.tsx`/`.scss` Bun loaders and the
render pipeline. It imports `sass` and `node:url`, so it never reaches a browser bundle.

The two are **disjoint**: no name is on both, and a file needing both imports both. That is the
price of the split and it is the point of it — a single barrel could not be bundled for the
browser at all, because `node:url`'s browser polyfill exports neither `fileURLToPath` nor
`pathToFileURL` and the build fails at link time. No `sideEffects` value fixes that (measured:
`false`, `[]` and an array naming only `errors.ts` all fail identically) — only not importing it
does.

**Importing `@ultimat3/render/server` installs the `.tsx`/`.scss` loaders**, once, as a module
side effect. Anything that loads an app's source — `x dev`, `x build`, `server.ts`, a test that
`await import()`s a `page.tsx` — reaches it before the module it loads.

## Public API

`†` marks a name on `@ultimat3/render/server`.

| Export | Owns |
|---|---|
| `defineRoute` | the `route` primitive |
| `island`, `createIslandCollector` | one interactive component on a static page |
| `MODE_SPECS`, `assertModeShape`, `assertModeInvariants` | the mode invariant table |
| `registerRoute`, `describeRoutes`, `routeFor`, `routePathFromFile` | the route table |
| `checkSurfaceBoundary`, `assertSurfaceBoundary`, `surfaceOf` | the hard boundary |
| `renderStatic`†, `enumeratePrerender`† | build-time render, content hashing |
| `createIsrController`†, `invalidateAndRevalidate`† | SWR + single-flight + tag triggers |
| `renderSsr`†, `streamResult`† | the per-request modes |
| `renderToHtml`†, `renderComponent`†, `stylesFor`† | the server JSX writer and the surface's css |
| `installRenderLoader`†, `compileStylesheet`† | the `.tsx`/`.scss` loaders, installed on import |
| `emitIslandAttributes`, `hydrateRuntime`, `HYDRATE_RUNTIME_BODIES` | the four hydration strategies, and every body the runtime script can hold — a host hashes that list into `script-src`, because the runtime is emitted inline and no `render: 'static'` file can receive a nonce |
| `ISLAND_MOUNTED_ATTRIBUTE`, `ISLAND_FAILED_ATTRIBUTE`, `IDLE_HYDRATE_TIMEOUT_MS` | what hydration looks like from outside the page |
| `parseByteBudget`, `defaultIslandBudget` | the `'40kb'` budget grammar, and the ceiling a declared island earns |
| `mergeHead`, `renderHead`, `themeScript` | `<head>` merge + the one inlined script |

## Notes

- **ISR** serves stale instantly, regenerates single-flight (a burst renders once), and
  registers each rendered page in `@ultimat3/cache`'s invalidation graph as an
  `isr-route` dependent of its `revalidate.tags`. So
  `action({ cache: { invalidates: [tag.post] } })` reaches ISR in the same hop as memo,
  LRU, Redis and the CDN, and regenerates exactly the dependent pages — nobody lists
  pages by hand, so nobody forgets one. `controller.attach()` installs it as the
  framework's `Revalidator`, and the function it returns releases **both** halves — the
  dependents and the revalidator slot, the latter only while it is still this controller's.
  The default store (`memoryIsrStore`) is capped at `DEFAULT_ISR_MAX_ENTRIES` (1,000) pages,
  least recently generated evicted first.
- **`stream`** flushes the shell first, then reveals holes in completion order with a
  ~200-byte inline script. A client that disconnects mid-stream cancels it: `StreamHole.resolve`
  is handed an `AbortSignal` so the work stops, and nothing more is enqueued. Solid's compiled templates and signals mean the shell costs zero
  hydration work, so streaming buys TTFB *and* TBT here, not just TTFB.
- **`hydrate: 'interaction'`** replays the event that woke the island; without replay the
  first click on a cold island is silently lost. It replays onto a node the mount left standing —
  the original target when the mount kept it, otherwise whatever `elementFromPoint` now answers for
  a pointer event, otherwise the island root. An island's `mount` opens with `el.textContent = ''`,
  so the pressed node is usually gone by the time the replay runs, and dispatching at it reached
  nothing: `hydrate: 'interaction'` is usable with a replacing island, and was not until
  `As of 2026-08-25`.
- **`hydrate: 'never'`** emits no attributes beyond the marker and no runtime — the `site/`
  0kb default is mechanical, not aspirational. A page that renders an island anyway is
  `X_ISLAND_NOT_HYDRATED`, not a silently dead button.
- **A gated page is `ssr`**, never a client-rendered shell. `spa` and `createRouter` were
  deleted `As of 2026-08-20`: `renderSpa` never read the route's component and no build ever produced the
  `chunks` it preloaded, so every `spa` route served an empty `<div id="x-root">`, and the router
  that shell would have needed had no caller in the framework or in either tracked app. A page
  whose body belongs in the browser declares `island({ src })` — one interactivity model, one
  bundler entry point, one budget measured against real bytes.
- `@ultimat3/http`'s `html()` / `stream()` turn a `RenderResult` into a `Response`; render
  never constructs one.
