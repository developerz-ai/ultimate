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
| `'document'` | always a real document load; the page itself carries **no router** (`As of 22.8.1`): no script, no navigation metas, none of the router's bytes charged to its budget — a `0b` page stays `0b`, and its own links and forms are plain browser navigations | a soft visit gets `204` + `x-ultimate-location`; the browser's own load runs it once |
| `'modal'` | shown **over** the page the visitor is on, addressed by the hash (`/runs#/runs/new`) — [Modals](#modals-a-page-over-a-page). A full load of its own URL is still the whole page | as absent: a prefetch gets an empty `204` |

**Use `'document'` for every GET that records something** — a recipient opening a link, a download
logged as evidence, a one-time token. **Use `'prefetch'` only for a GET that does nothing but
render.** Declaring any of the three on a surface without client navigation refuses the boot
(`X_ROUTE_NAVIGATION_INVALID`).

An opted-in document (every page of the surface except a `'document'` one) carries:

| Tag | Why |
|---|---|
| `<meta name="ultimate-navigation" content="<app>:<surface>">` | which router may swap it in. The app's `name` is part of it, so two apps on one origin (web and admin) never swap each other's pages |
| `<meta name="x-ultimate-build" content="…">` | the skew check |
| `<script src="/_x/assets/navigation/<hash>.js" defer>` | the router: one classic script, content-addressed, `immutable`, `'self'` under the default CSP. `x dev`, the container and `x build --target static` all serve or write it |

**Budget:** the router is 24,058 B minified (8,836 B gzip) `As of 26.1.0` — 19,966 B before
route-presented modals and navigating from code (+4,092 B). It is **charged** to
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
| any router request answered with a 3xx (a form's 303, a sign-in wall, a `load`'s `setRedirect`, an OAuth or payment hop) | any | `204` + `x-ultimate-location: <target>`, cookies kept. The handler ran once; the router follows a same-origin target as its own next request, and hands another origin to the browser. A target that is not `http:`/`https:` (or will not parse) is never handed over: the header names the requested URL instead, as a path |
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
| a link to another page, or another query on this page | a fragment on the page already shown, `href="#"` included: the browser scrolls, nothing is fetched. An `href` or form `action` no URL parses (`http://`): the browser decides |
| `<form method="get">`: navigates to its query, like the browser | `method="dialog"`; a `target`; another origin; `data-x-reload` on the form or its submitter |
| `<form method="post">`, url-encoded or multipart | a POST with a chosen file (the browser's own upload progress); `enctype="text/plain"` |

The submitter's `formaction`, `formmethod`, `formenctype`, `formtarget` and its own name/value are
honoured. A GET query and a url-encoded body carry every line break as CRLF, as a native submit does
(`As of 2026-10-02`): a `<textarea>` sends the same bytes with the router as without it.

### What happens to the answer

| Answer | Result |
|---|---|
| a page of this surface, build and principal | swapped in |
| a 4xx/5xx page to a GET, whatever rendered it (the framework's own error page carries no surface meta) | swapped in: a `load` that wrote and then threw is never run a second time. The next click is a real load |
| `204` + `x-ultimate-location`, same origin | followed as the router's next request (at most 5 hops), or loaded when it names the URL just asked for |
| `204` + `x-ultimate-location`, another origin | the browser goes there |
| an empty `204` | nothing: the browser stays, as it does for a `204` navigation |
| a 2xx that is not a page (a PDF, a zip, JSON) | handed to the browser **from the bytes already received**: saved under its `Content-Disposition` name when `attachment`, shown otherwise. Never asked for again |
| a 4xx/5xx that is not a page (an offline service worker's empty `503`, a JSON `404`) | a GET: a full load of the URL asked for — the one answer the router asks for again, since there is nothing to show (`As of 2026-10-05`). A POST: `ultimate:navigation-error`, never re-sent |
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
`reduce`. Style the transition with the standard `::view-transition-*` pseudo-elements. While it
animates the browser hit-tests every press to `<html>` (Chrome does whatever `pointer-events` the
overlay has), so a click that lands there skips the animation and is given to the element under the
pointer: the visitor's first click after a swap is never lost. A bare press — a touch that scrolls,
a long press — never skips it, so named elements finish their glide (`As of 2026-10-05`).

## History, scroll, focus

| Concern | Behaviour |
|---|---|
| history | `pushState` per navigation, each entry naming the document it shows; `replaceState` for the same URL. Back/forward to an entry whose document is not the one on screen swaps it in; an entry an app pushed shows the document of its path |
| scroll | top on a new page; the fragment's element for `#id`; back AND forward restore the saved position (saved as the visitor scrolls), and so do a reload and a Back that is a full document load (`As of 2026-10-02`). Always `instant`, whatever `scroll-behavior` says |
| focus | moved to the new page's `<main>` (else its first `<h1>`), `tabindex="-1"` added if needed |
| announcement | the new `document.title`, in a polite `aria-live` region the router owns |
| progress | `data-x-navigating` on `<html>` once a navigation runs past 150 ms. No bundled UI: style it, e.g. `html[data-x-navigating] main { opacity: 0.6 }` inside `prefers-reduced-motion: no-preference` |

## Prefetch

On intent: `pointerover` that rests 65 ms, `focusin`, `touchstart`. The server answers only pages
that declared `navigation: 'prefetch'`; everything else is an empty `204`, remembered so a second
hover does not ask again. Answers wait in a per-tab **memory** cache (never storage), 30 s, at most 20
documents, keyed with the query sorted and without the fragment. It is the ONLY reuse layer: every
router fetch goes out `cache: 'no-cache'`, so the browser's HTTP cache never answers a soft
navigation — an anonymous page's `stale-while-revalidate` would otherwise show the document from
before a write, a sign-out or a deploy (`navigation-fetch.ts`; issue #693).

| A prefetched answer is never used when | |
|---|---|
| it is not a 2xx page, or it was a hand-over (a redirect, a login wall) | the click asks again |
| the server said `no-store` and the click came more than 5 s later | the click asks again |

| The cache is emptied by | |
|---|---|
| any POST the router sends — when it is sent, and again when it settles, landed or failed: a prefetch sent while it was in flight may have rendered the old state | |
| any write through the framework's client (`rpc`, a mutation, an upload — `@ultimat3/core`'s `onClientWrite`) | |
| a principal change: `onRescope`, a load for another principal, a POST answered for one, and every hand-over of the very URL asked for (the server's principal check answers that way, and the router cannot tell it from a `'document'` page — so it forgets either way) | |
| a `BroadcastChannel('ultimate:navigation')` message from another tab — each of the above posts one | |
| the page's return from the back/forward cache: the channel is closed on `pagehide` (an open one keeps a page out of that cache), so every message sent meanwhile was missed | |

Never prefetched at all: a link with `data-x-no-prefetch`, anything the click rules leave to the
browser, anything on `Save-Data` or a `2g`/`slow-2g` connection, and the page a navigation is
already fetching. A press or click cancels a pending hover's prefetch, and the focus a press gives a
link is not an intent — so a fast click sends exactly one request (`As of 22.8.1`).

## Without the router: the browser's own prefetch

`As of 2026-09`. A document that carries **no** router — every page of a surface outside
`navigation.client`, and every `navigation: 'document'` page — carries one
`<script type="speculationrules">` instead: the browser fetches a link's document before the click,
and the full-page load that follows paints from memory. No JavaScript ships for it; a `0kb` page
stays `0kb` (`budgets.ts` reads the block as data). **Prefetch only, never prerender** — a prerender
runs the next page's scripts for a page nobody opened.

```ts
navigation: { speculation: { prefetch: 'moderate', exclude: ['/blog/borrador-*'] } },
```

| `speculation.prefetch` | The browser fetches |
|---|---|
| `'moderate'` (default) | on pointer rest (~200 ms) or pointer down |
| `'conservative'` | on pointer down only |
| `false` | nothing: no tag, no CSP source |

The rules are an **allow-list** from the route table — a prefetch is a real GET with the visitor's
cookies, so only a page the table says is a pure read is a candidate:

| A page is a candidate when | Why |
|---|---|
| its surface has no router, and it is `static` or `isr` with no policy | it was rendered at build time, for nobody |
| its surface has the router, and it declared `navigation: 'prefetch'` | the app's own statement that its GET is a pure read |

Never a candidate: a `navigation: 'document'` page, an `ssr` page of a surface without the router
(it has no way to say its GET records nothing), an `offline: 'network-only'` page, an `api/` route,
and anything that is not a page — `/_storage/*`, `/mcp*`, an app's plain routes. Each candidate is
one URL pattern covering every routed locale (`{/en}?/precios`, `{/en}?/blog/:slug`);
`speculation.exclude` subtracts more, as URL patterns starting with `/`.

The body is the same string on every document of the app, sorted, and `script-src` admits it by
sha256 hashed from that string (`page-speculation.ts`), so the enforced policy needs no
`'unsafe-inline'`. Browsers without Speculation Rules ignore the block.

## Opting a link or form out

| Want | Write |
|---|---|
| a full load for this link or form | `data-x-reload` |
| soft on click, never fetched early | `data-x-no-prefetch` |
| a full load for every link to a page, from anywhere | `navigation: 'document'` on its route |
| an element that survives navigations | `data-x-persist="<stable id>"` on it, in both pages |

## Modals: a page over a page

`As of 26.1.0`. A create form, an edit step, a confirmation: a page whose route says it is
presented over another.

```ts
// app/runs/new/page.tsx
import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'ssr',
  offline: 'network-only',
  meta: ({ t }) => ({ title: t('runs.new') }),
  navigation: 'modal',
});
```

```tsx
// app/runs/page.tsx — an ordinary link: without the router it is the whole page
<a href="/runs/new">New run</a>
```

**Two routers, one URL.** The PATH is the page on screen, swapped as everywhere else on this page.
The HASH is the one modal over it, and the hash's path is itself a route of the same surface:
`/runs#/runs/new`, `/projects/7#/projects/7/members/invite` — any depth, with a query
(`#/runs/new?bank=ve`). Every other fragment (`#below`) is still a fragment. Link the page's own
path; the router writes the hash.

| Visit | Result |
|---|---|
| a click on a link to a `'modal'` page | its document fetched (one soft GET), its `<main>` shown in a native `<dialog>` over this page; the URL becomes `<this page>#<its path>`, pushed |
| a reload, a pasted or bookmarked `/runs#/runs/new`, Forward onto it | `/runs` renders; the router opens `/runs/new` over it |
| a hash typed over the page | the same |
| a hash naming anything else — a page that is not `'modal'`, a 404, a redirect, another principal's page, `#//host` | **just the page**: the hash is dropped in place. Never followed, loaded, or shown as an error |
| a full load of `/runs/new` itself, scripting off, `data-x-reload` | the whole page, as before — the server renders one document for both |
| a link to the page on screen that is itself a `'modal'` route | that page, swapped in as usual |

**Why the route, and not the link (axiom 1).** Presentation is a property of the page: a create
form is a modal wherever it is reached from, and the one place that can say so for EVERY way of
reaching it — a link, a redirect after a POST, a pasted hash — is its route. A link attribute
would be a second declaration two links to one page could disagree on, and a redirect has no link
to carry it. The server names the page a modal in its own document
(`<meta name="ultimate-presentation" content="modal">`); the router never decides it.

**Why the whole document, and not a fragment.** The router asks for the page exactly as a full
load does — same policy, same `load`, same cache headers, no request header that varies the
answer — and shows its `<main>`. A second shape of one URL would need `Vary`, could not be a
`static` or `isr` file, and would put two answers under one key in every cache on the way.

### Inside the modal

| Concern | Behaviour |
|---|---|
| markup | one `<dialog data-x-modal>` opened with `showModal()`: top layer, `::backdrop`, the page beneath inert, focus moved in. Named by its first `h1`/`h2` (`aria-labelledby`), else by the page's title. The tab's title is the modal's while it is open |
| the page beneath | untouched: its islands stay mounted, its socket and page store live, its scroll where it was |
| links and forms | resolved against the MODAL's URL, as on its own page: `href="?step=2"` is `/runs/new?step=2`, a form with no `action` posts to `/runs/new` |
| islands in the modal | booted by the page's hydration runtime; disposed when the modal closes or its content is replaced |
| styles | the modal page's stylesheets load first. `@ultimat3/ui`'s `global.scss` styles `dialog[data-x-modal]` as its `Dialog` (`surface-raised` over `scrim`), under `:where()` so an app restyles it at zero specificity; its reset locks the body scroll behind any modal `<dialog>` |
| one at a time | a link to another `'modal'` page from inside replaces the content of the same dialog and pushes, so Back steps out one level (`#/runs/new` → `#/runs/new/advanced` → Back → `#/runs/new`) |

### Closing

| Gesture | Result |
|---|---|
| Escape, a press outside it (the dialog carries `closedby="any"`; a browser without it gets the same from the router's click on the backdrop), a `<form method="dialog">`, any way the browser closes the dialog | **Back**, when the entry is the one the router pushed; otherwise (a cold-loaded address — Back would leave the app) the hash is dropped in place |
| the browser's Back | the entry beneath has no modal: closed |
| a link to the page beneath (the page's own **Cancel**, which is also its no-JS way back) | as Escape — nothing is fetched |
| a link anywhere else | that page swaps in, in place of the modal's entry |

Focus returns to the link or button that opened it; the title returns to the page's.

The router renders **no close button**: it has no catalog to name one in, and a page that is also
a full page already has its way back. Give the modal page a Cancel link to the page it is opened
over (or a `<form method="dialog">` button).

### Forms inside

A form inside the modal submits through the router like any other: the POST is sent once, never
again.

| The server answers | Result |
|---|---|
| the modal page again (a `422` re-render with its errors) | shown in the same dialog; the address stays (`replace`) |
| a redirect to the page beneath (`303 /runs`) | the modal closes and the page is fetched and swapped in — its content refreshed — through Back, so the spent form's entry is not left to reopen |
| a redirect anywhere else | the target swaps in, in place of the modal's entry |
| a redirect to another `'modal'` page (create, then confirm) | shown in the same dialog, in place of the form's entry |
| nothing (the network failed) | `ultimate:navigation-error`, never re-sent; its default reloads the tab — the page and its modal both asked for again, since a hash alone is only scrolled to |
| anything else (a download, another principal) | as on any page — [What happens to the answer](#what-happens-to-the-answer) |

A `'modal'` page's form on its own full page is an ordinary page form: a re-render there is a
page, never a modal.

## Navigating from code

`As of 2026-10`. From an island or an app script, never by clicking a hidden link — imported from
`@ultimat3/render/client`, the package's browser entry:

```ts
import { closeModal, navigate, openModal, refresh } from '@ultimat3/render/client';

await navigate('/runs/7'); // as a click on a link to it
await navigate('/runs?status=failed', { replace: true }); // the current entry replaced
await refresh(); // the page on screen, rendered again, where it is scrolled
await openModal('/runs/new'); // the `navigation: 'modal'` route over this page: /runs#/runs/new
closeModal(); // as Escape
```

| Call | With the router | Without it (a `site/` page, a `'document'` page, the router's script blocked) |
|---|---|---|
| `navigate(url, { replace? })` | the router's own navigation: the server's gate and the answer decide swap, modal or full load. Another origin: a document load | `location.assign` / `location.replace` |
| `refresh()` | the page fetched again (never from the prefetch cache) and swapped in with no history entry, at the visitor's scroll. An open modal is fetched again over it | `location.reload()` |
| `openModal(path)` | `#<path>` over the page, pushed, so Back closes it. A path that is not a modal of this tab opens nothing, as a stale hash | `location.assign(path)`: the modal route's whole page |
| `closeModal()` | as Escape: Back through the router's own entry, else the hash dropped in place | nothing — no modal is open |

`openModal` takes the route's own path, as its link would (`'/runs/new'`, `'/runs/new?bank=ve'`); a
full URL, `//host` or a relative path is a rejected promise, `X_NAVIGATION_MODAL_PATH_INVALID` —
never a synchronous throw, so `.catch` sees it. On the server
every call does nothing. The functions import the router's TYPE only: an island that navigates
ships none of the router's bytes.

Import them from `/client`, never from `@ultimat3/render`: the barrel keeps render's whole error
table in any chunk that reaches it. An island whose body is `refresh()` is 216 B minified from
`/client` and was 9,323 B from the barrel (`packages/render/src/client-bundle.test.ts`, `As of
2026-10-08`). The barrel still exports them, for compatibility. The rejection is
`NavigationModalPathInvalidError`, one class from either entry, so `instanceof` holds whichever an
app imports; read `.code` when the two halves of an app may disagree on where they import from.

## Events

Dispatched on `document`:

| Event | When | `detail` |
|---|---|---|
| `ultimate:navigate` | before the fetch. **Cancelable**: `preventDefault()` keeps the tab where it is | `{ url, method }` |
| `ultimate:navigated` | after the swap, the scroll and the new scripts — and after a modal opens, its `url` the modal's | `{ url }` |
| `ultimate:navigation-error` | a POST that failed or could not be shown, a swap that failed on a POST. **Cancelable**: the default is a GET of the current page | `{ url, method, reason }` |

The three event names are on `@ultimat3/render/client` too — what an island listens with. The event
names and attributes are exported from `@ultimat3/render` (`NAVIGATE_EVENT`,
`NAVIGATED_EVENT`, `NAVIGATION_ERROR_EVENT`, `NAVIGATION_RELOAD_ATTRIBUTE`,
`NAVIGATION_NO_PREFETCH_ATTRIBUTE`, `NAVIGATION_PERSIST_ATTRIBUTE`, `NAVIGATING_ATTRIBUTE`,
`NAVIGATION_PRESENTATION_META`, `NAVIGATION_MODAL_ATTRIBUTE`), with the pure rules the router runs
(`linkVerdict`, `formVerdict`, `responseVerdict`, `reusable`, `mayPrefetch`, `modalAddress`,
`presentation`, `modalHistory`, `leaveModal`). The headers are `@ultimat3/core`'s, imported from there only
(`CLIENT_NAVIGATION_HEADER`, `CLIENT_NAVIGATION_LOCATION_HEADER`, `CLIENT_NAVIGATION_SCOPE_HEADER`,
`CLIENT_NAVIGATION_SURFACE_HEADER`) — render's `NAVIGATION_*_HEADER` aliases were deleted in 25.0.0. The server half is
`@ultimat3/http`'s `navigationGate`, `redirectForRouter` and `relocate`.

## Tested where

| What | Where |
|---|---|
| every client rule, as pure functions | `packages/render/src/navigation-rules.test.ts`, `navigation-cache.test.ts`, `navigation-dom.test.ts`, `route-navigation.test.ts`, `navigation-modal-rules.test.ts` |
| a `'modal'` page: never prefetched, one document for a soft and a full load, the meta it carries | `packages/cli/src/page-navigation.test.ts` |
| modals in a real Chrome: open over a live page, Escape/Back/Cancel, reload and pasted hash, stale hash, nesting, a refused and a redirected submit, a confirmation, `openModal`/`closeModal`/`refresh` from code, scripting off | `packages/cli/e2e/client-navigation-modal.e2e.test.ts` |
| navigating from code: through the router, the browser's fallbacks, the server, `openModal`'s refusal | `packages/render/src/navigation-api.test.ts` |
| the server gate and the redirect hand-over, counting handler runs | `packages/http/src/navigation.test.ts` |
| speculation rules: which pages are candidates, the tag on a router-less document only, the CSP hash of the served bytes | `packages/cli/src/page-speculation.test.ts`, `packages/render/src/speculation-rules.test.ts` |
| real pages: prefetch and `'document'` run no `load`, another principal or app is refused, a misplaced key refuses the boot | `packages/cli/src/page-navigation.test.ts` |
| writes announced after they settle | `packages/core/src/client-writes.test.ts` |
| in a real Chrome, through the real pipeline under an enforced CSP: every rule above, counted in route executions | `packages/cli/e2e/client-navigation-*.e2e.test.ts` |
| the reference app, opted in: real pages, sign-out, a like after a round trip, the editor as a modal over the feed, scripting off | `examples/dummy/apps/web/e2e/client-navigation.e2e.test.ts` |
