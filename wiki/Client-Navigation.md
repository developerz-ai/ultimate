# Client navigation

Moving between pages of an opted-in surface without a full document load: the router fetches the
next page **the server renders anyway** and swaps it into the same tab. The tab keeps its islands
that did not change, its socket, its page store and its scroll history, so an app of server pages
feels like an installed one.

**Not a render mode.** Every page is still rendered by its own route, in its own mode (`ssr`,
`stream`, `static`, `isr`), behind its own policy and cache headers. The router only decides what
the browser does with the answer. Without the script (scripting off, or a link marked
`data-x-reload`), the same markup is an ordinary multi-page app. Why this and not a client-rendered
mode: [docs/history/render.md](https://github.com/developerz-ai/ultimate/blob/main/docs/history/render.md).

**One rule over everything below: nothing the router sends is sent twice, and nothing it guesses
runs a route that did not ask for it.** The server enforces both, before any app code runs.

## Opt in: per surface, then per page

```ts
// app.config.ts
export const config = defineConfig({
  name: 'notificado',
  navigation: { client: ['app'] },
});
```

| `navigation.client` | Effect |
|---|---|
| `[]` (default) | every navigation is a full load; no surface ships a router byte |
| `['app']` | `app/` pages navigate softly; `site/` stays 0kb of JS |
| `['site', 'app']` | both. Crossing from one surface to the other is still a full load |

`api` and `shared` render no documents and are refused (`X_CONFIG_INVALID`).

A page may then say how the router treats it, with the route's twelfth key:

```ts
export const config = defineRoute({ render: 'ssr', …, navigation: 'prefetch' });
```

| `navigation` | The router | The server, before `load` |
|---|---|---|
| absent | swaps the page in on a click; never fetches it early | a prefetch gets an empty `204` |
| `'prefetch'` | also fetches it on hover/focus | a prefetch is answered like a visit |
| `'document'` | always a real document load | a soft visit gets `204` + `x-ultimate-location`; the browser's own load runs it once |

**Use `'document'` for every GET that records something** — a recipient opening a link, a download
logged as evidence, a one-time token. **Use `'prefetch'` only for a GET that does nothing but
render.** Declaring either on a surface without client navigation refuses the boot
(`X_ROUTE_NAVIGATION_INVALID`).

An opted-in document carries:

| Tag | Why |
|---|---|
| `<meta name="ultimate-navigation" content="<app>:<surface>">` | which router may swap it in. The app's `name` is part of it, so two apps on one origin (web and admin) never swap each other's pages |
| `<meta name="x-ultimate-build" content="…">` | the skew check |
| `<script src="/_x/navigation/<hash>.js" defer>` | the router: one classic script, content-addressed, `immutable`, `'self'` under the default CSP. `x dev`, the container and `x build --target static` all serve or write it |

**Budget:** the router is 18,276 B minified (6,852 B gzip) `As of 2026-09-28`. It is **charged** to
every route on the surface, like realtime's page boot, because it is interactivity the app opted
into. Raise a route's `budget.js` by the measured amount (`bun run budget-raises`).

## What the server enforces

Every router request carries `x-ultimate-navigation: soft | prefetch`, the document's
`x-ultimate-surface: <app>:<surface>`, its principal (`x-ultimate-navigation-scope`, when the
document has one) and, on a GET, its `x-ultimate-build`. `@ultimat3/http` answers **before auth,
before any hook, before the handler**:

| Request | Route | Answer |
|---|---|---|
| prefetch | anything but a page declaring `'prefetch'` (actions, queries, assets, storage, app routes, pages) | `204`, nothing ran |
| soft GET | anything but a page of THIS router's `<app>:<surface>` (a download, an evidence GET, a `'document'` page, another surface or app) | `204` + `x-ultimate-location: <same url>`; the router loads it for real, and it runs once |
| soft GET | a page rendered for another principal than the router's document | `204` + `x-ultimate-location`, before `load` |
| GET | a tab on another build | `409` from the existing build check; the router loads the page for real |
| any router request answered with a 3xx (a form's 303, a sign-in wall, a `load`'s `setRedirect`, an OAuth or payment hop) | any | `204` + `x-ultimate-location: <target>`, cookies kept. The handler ran once; the router follows a same-origin target as its own next request, and hands another origin to the browser |
| POST | any | never gated: it is the form's submission |

A soft GET across a principal change runs auth and rate-limit **twice** — once before the `204` of
the principal row above, once for the real load. Expected and harmless (auth and rate-limit only;
the handler and `load` run once), but a tight per-actor rate limit should budget one extra request
per sign-in or sign-out navigation.

The router never lets `fetch` follow a redirect (`redirect: 'manual'`), so a CORS-refused hop to
another origin, or a target on another surface, is never fetched and then asked for again.

## What the router takes, and what it leaves to the browser

Clicks and submits are read on `window` in the bubble phase, **after** every handler on the page:
a handler that calls `preventDefault()` keeps the event.

| Taken (soft) | Left to the browser (native) |
|---|---|
| left click on a same-origin `<a href>` / `<area href>` | a modifier key or another button; `target` other than `_self`; `download`; `rel="external"`; `data-x-reload`; another origin or scheme |
| a link to another page, or another query on this page | a fragment on the page already shown: the browser scrolls, nothing is fetched |
| `<form method="get">`: navigates to its query, like the browser | `method="dialog"`; a `target`; another origin; `data-x-reload` on the form or its submitter |
| `<form method="post">`, url-encoded or multipart | a POST with a chosen file (the browser's own upload progress); `enctype="text/plain"` |

The submitter's `formaction`, `formmethod`, `formenctype`, `formtarget` and its own name/value are
honoured.

### What happens to the answer

| Answer | Result |
|---|---|
| a page of this surface, build and principal | swapped in |
| a 4xx/5xx page to a GET, whatever rendered it (the framework's own error page carries no surface meta) | swapped in: a `load` that wrote and then threw is never run a second time. The next click is a real load |
| `204` + `x-ultimate-location`, same origin | followed as the router's next request (at most 5 hops), or loaded when it names the URL just asked for |
| `204` + `x-ultimate-location`, another origin | the browser goes there |
| an empty `204` | nothing: the browser stays, as it does for a `204` navigation |
| not a page (a PDF, a zip, JSON) | handed to the browser **from the bytes already received**: saved under its `Content-Disposition` name when `attachment`, shown otherwise. Never asked for again |
| a POST answered in place with a page | swapped in: it cannot be repeated. When it was rendered for ANOTHER principal or build (a sign-in that renders instead of redirecting), every tab's cache is emptied and this tab stops swapping: every later link and form is a real document load |
| a page from another surface, build or principal where no framework server answered (a static host) | a full load |

### When something fails

| Failure | Result |
|---|---|
| a GET fails on the network | the browser loads it (its own offline page) |
| a POST fails on the network, or its answer cannot be read | **never re-sent.** `ultimate:navigation-error` on `document` (cancelable, `detail: { url, method, reason }`); its default is a GET load of the page the visitor is on, which shows what the server actually has |
| the swap throws part-way, or the answer's body cannot be read | a real load of the page (GET), or `ultimate:navigation-error` (POST) — never a half-replaced page |

**A failed swap or body read loads a GET for real, so its route runs a second time.** That is why a
page whose GET records anything must be `navigation: 'document'`: the server then never runs it for
a soft request at all.

**A failed POST's default is a GET reload of the current page.** On a page where reloading has an
effect of its own (it is itself a `'document'` page, or its GET records something), put
`data-x-reload` on its forms — the browser then submits them natively — or cancel
`ultimate:navigation-error` and show the failure in place.

A navigation started while another is in flight aborts the older one; the slower answer is never
swapped in over the newer page.

## The swap

In one order, so no frame is unstyled and no island runs twice:

1. **Stylesheets** the next page links and this one has not loaded are loaded first.
2. **Islands** of the old body are disposed: each one's `mount` return value, when it is a
   function, is called (Solid's `render` returns one).
3. **Body** replaced. Elements marked `data-x-persist="<id>"` in **both** documents are carried
   across live (same node, same state, islands inside still mounted). What the element SAYS about
   the page follows the incoming one: its own attributes (the ones a server document set — never one
   a script added), and every descendant's `aria-current` with the `class` beside it, matched by `id`
   or by position. A sidebar's active item moves.
4. **Head** brought level by markup: server-rendered tags only this page had go (JSON-LD
   included), tags only the next has arrive, identical ones stay. Tags a **script** added at run
   time (a CSS-in-JS `<style>`, analytics) are the tab's and are never removed. The previous page's
   own stylesheets it no longer links are retired after the swap. `<html lang>` and `dir` follow.
5. **Scripts**: the next page's head `<script src>` and its body scripts run, in order. The inline
   hydration runtime runs again and boots the new islands; it visits each island root once per tab,
   so a carried island is not booted twice. A `src` this tab already ran is not run again. An
   inline head script runs when its TEXT is new to this head (once per page that carries it, as a
   full load would), never when the current head already has it (the theme boot, on every page);
   one only the previous page had is removed. Every inline script, head or body, still needs its
   CSP hash — the router re-inserts the same text, and the policy judges it as on a full load.

Inside `document.startViewTransition` when the browser has it and `prefers-reduced-motion` is not
`reduce`. Style the transition with the standard `::view-transition-*` pseudo-elements.

## History, scroll, focus

| Concern | Behaviour |
|---|---|
| history | `pushState` per navigation, each entry naming the document it shows; `replaceState` for the same URL. Back/forward to an entry whose document is not the one on screen swaps it in; an entry an app pushed shows the document of its path |
| scroll | top on a new page; the fragment's element for `#id`; back AND forward restore the saved position (saved as the visitor scrolls). Always `instant`, whatever `scroll-behavior` says |
| focus | moved to the new page's `<main>` (else its first `<h1>`), `tabindex="-1"` added if needed |
| announcement | the new `document.title`, in a polite `aria-live` region the router owns |
| progress | `data-x-navigating` on `<html>` once a navigation runs past 150 ms. No bundled UI: style it, e.g. `html[data-x-navigating] main { opacity: 0.6 }` inside `prefers-reduced-motion: no-preference` |

## Prefetch

On intent: `pointerover` that rests 65 ms, `focusin`, `touchstart`. The server answers only pages
that declared `navigation: 'prefetch'`; everything else is an empty `204`, remembered so a second
hover does not ask again. Answers wait in a per-tab **memory** cache (never storage), 30 s, at most 20
documents, keyed with the query sorted and without the fragment.

| A prefetched answer is never used when | |
|---|---|
| it is not a 2xx page, or it was a hand-over (a redirect, a login wall) | the click asks again |
| the server said `no-store` and the click came more than 5 s later | the click asks again |

| The cache is emptied by | |
|---|---|
| any POST the router sends | |
| any write through the framework's client (`rpc`, a mutation, an upload — `@ultimat3/core`'s `onClientWrite`) | |
| a principal change: `onRescope`, a load for another principal, a POST answered for one, and every hand-over of the very URL asked for (the server's principal check answers that way, and the router cannot tell it from a `'document'` page — so it forgets either way) | |
| a `BroadcastChannel('ultimate:navigation')` message from another tab — each of the above posts one | |

Never prefetched at all: a link with `data-x-no-prefetch`, anything the click rules leave to the
browser, and anything on `Save-Data` or a `2g`/`slow-2g` connection.

## Opting a link or form out

| Want | Write |
|---|---|
| a full load for this link or form | `data-x-reload` |
| soft on click, never fetched early | `data-x-no-prefetch` |
| a full load for every link to a page, from anywhere | `navigation: 'document'` on its route |
| an element that survives navigations | `data-x-persist="<stable id>"` on it, in both pages |

## Events

Dispatched on `document`:

| Event | When | `detail` |
|---|---|---|
| `ultimate:navigate` | before the fetch. **Cancelable**: `preventDefault()` keeps the tab where it is | `{ url, method }` |
| `ultimate:navigated` | after the swap, the scroll and the new scripts | `{ url }` |
| `ultimate:navigation-error` | a POST that failed or could not be shown, a swap that failed on a POST. **Cancelable**: the default is a GET of the current page | `{ url, method, reason }` |

The names, attributes and headers are exported from `@ultimat3/render` (`NAVIGATE_EVENT`,
`NAVIGATED_EVENT`, `NAVIGATION_ERROR_EVENT`, `NAVIGATION_RELOAD_ATTRIBUTE`,
`NAVIGATION_NO_PREFETCH_ATTRIBUTE`, `NAVIGATION_PERSIST_ATTRIBUTE`, `NAVIGATING_ATTRIBUTE`,
`NAVIGATION_HEADER`, `NAVIGATION_LOCATION_HEADER`), with the pure rules the router runs
(`linkVerdict`, `formVerdict`, `responseVerdict`, `reusable`, `mayPrefetch`). The server half is
`@ultimat3/http`'s `navigationGate`, `redirectForRouter` and `relocate`.

## Tested where

| What | Where |
|---|---|
| every client rule, as pure functions | `packages/render/src/navigation-rules.test.ts`, `navigation-cache.test.ts`, `navigation-dom.test.ts`, `route-navigation.test.ts` |
| the server gate and the redirect hand-over, counting handler runs | `packages/http/src/navigation.test.ts` |
| real pages: prefetch and `'document'` run no `load`, another principal or app is refused, a misplaced key refuses the boot | `packages/cli/src/page-navigation.test.ts` |
| writes announced after they settle | `packages/core/src/client-writes.test.ts` |
| in a real Chrome, through the real pipeline under an enforced CSP: every rule above, counted in route executions | `packages/cli/e2e/client-navigation-*.e2e.test.ts` |
| the reference app, opted in: real pages, sign-out, a like after a round trip, scripting off | `examples/dummy/apps/web/e2e/client-navigation.e2e.test.ts` |
