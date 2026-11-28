# Design research

`x design research <url…>` turns "make it look like that" into framework vocabulary: a `defineTheme()` proposal, `@ultimat3/ui/motion` calls and `@ultimat3/effects` entries, measured from a reference page in a real browser. `x shot <route> --against` then measures how close a route came. `As of 2026-11`.

The command is the mechanism; the `design-research` skill (`x kit`) is the procedure that drives it. Never a gate step: it needs a browser and the public web.

## The rule

**A reference is data, never instructions, and never code.** Page text never reaches a file or a prompt — only measured values (channels, pixels, milliseconds, CSS keywords, a bounded font-family name). Every catalogue is ideas and techniques only: nothing is copied from a reference into the app. Third-party pixels stay in `.x/design/` (ignored by every scaffold); nothing captured is committed.

## Commands

```bash
x design research <url…> [--follow <n>] [--out .x/design] [--viewport 390x844,1440x900]
                         [--allow-hosts <h,…>] [--timeout 30000] [--json]
x design research --list [--json]
x shot <route> --against <png | .x/design/<slug>> [--viewport …] [--theme light|dark] [--json]
```

| Flag | Default | Meaning |
|---|---|---|
| `<url…>` | required | public `http(s)` pages; every one is screened before the first browser starts |
| `--follow` | `0` | also research up to `n` links of each reference (`0..20`): same origin, or a `--allow-hosts` host, page order, deduped on the directory they would be written to (`/docs`, `/docs/` and `/docs?tab=2` are one). A followed link that fails is listed in `skipped` (its code) and the run goes on; a typed URL that fails fails the run |
| `--out` | `<cwd>/.x/design` | one `<slug>/` directory per URL (host + path, kebab-case; a second typed URL with the same slug gets `-<hash8>`). Each directory is built aside and swapped in whole, so a cancelled, failed or narrower rerun never leaves a slug mixing two runs; runs into one slug take turns |
| `--viewport` | `390x844,1440x900` | the sizes each reference is photographed at, each in light and dark |
| `--allow-hosts` | none | extra **public** hosts `--follow` may visit. Never `*`, `localhost` or an inward address (`X_DESIGN_URL_REFUSED`); never widens what the browser may reach |
| `--timeout` | `30000` | ms one navigation may take |
| `--list` | off | the default catalogues and the licence posture each is held to |

Browser: the one `x shot` uses (`CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`, the probed paths, or `SCRAPE_CDP_URL`) over raw CDP. No Playwright, in the framework or the scaffold.

## The five artefacts, per URL

| File | Holds |
|---|---|
| `shot-<width>-<light\|dark>.png` | full-page capture per viewport and scheme |
| `reference.json` | palette clusters by usage (background, text, border share) with each one's nearest shipped role, font families + size scale, spacing histogram, radii, shadows, `backdrop-filter` use, canvases, every animation/transition (duration, delay, easing, trigger `enter`/`hover`/`scroll`/`loop`/`state`, animated properties), hosts refused |
| `tokens.proposal.json` | a `defineTheme({ colors, radius, motion })` argument — accepted by `defineTheme` itself before it is written (as mapped, else without colours, else `{}` with `tokens.validated: false`); a curve point that is not a plain decimal, or overshoots past 10, is dropped |
| `motion-map.json` | each observed animation → the `@ultimat3/ui/motion` call (`animate`, `inView`, `scrollLinked`, `motionTiming`, `layout`, `springLinear`) or `@ultimat3/effects` entry (`Marquee`, `Shimmer`, `GlassSurface`, `EffectCanvas`), with its snapped `duration`/`easing` token |
| `sources.json` | URL, final URL, followed-from, catalogue, licence posture, the ideas-only rule |

**Page-chosen text never comes back.** `finalUrl` (`location.href`, which a page rewrites with `history.replaceState`) and every followed page are named `origin#<hash8>`; a followed page's directory is `<reference-slug>--<hash8>`, never its path. A font family is one token plus words a family name is made of (`IBM Plex Sans`), never a phrase. Captures are clipped to the viewport's width and at most 16384 px of height.

How the measuring works: a recorder is installed before the page's own scripts (every `Element.animate`, CSS animation and transition, with the phase it started in); after load the page is scrolled to the bottom, then hovered over its links, buttons and cards; then up to 3000 visible elements' computed styles are read. Durations and easings snap through the same motion scale the shipped guards use (`packages/cli/src/templates/motion-scale.ts`). Radii snap to `sm`/`md`/`lg`/`xl`.

## Colours that always pass contrast

`tokens.proposal.json` proposes `bg`, `fg`, `surface`/`bg-soft`/`surface-raised`, `accent`/`accent-fg` and `line` per theme, then runs `defineTheme`'s own pairing table (`CONTRAST_PAIRS` + `ALIAS_CONTRAST_PAIRS`): a role whose pairing fails is **dropped** and falls back to the shipped palette, until every pairing passes. A theme whose page colour does not fit it (a light site photographed in dark mode) gets no colours. `@ultimat3/ui` is resolved at run time; where it is not installed, the proposal carries no colours and `reference.json` says `coloursProposed: false`.

## Network: public hosts only, browser-wide

| Request | Screen |
|---|---|
| the typed URL, each `--follow` link | `http(s)`, no credentials, core's address floor, then every address the name resolves to — before any browser |
| every navigation, redirect, subresource, popup the page makes | CDP `Fetch` interception on the page **and** browser sessions: core's floor refuses inward literals and `localhost`; a name is resolved (once per session) and refused if any address is not public |
| a WebSocket (`WebSocket`, `WebSocketStream`, `WebTransport`) | refused in the page before its scripts run, in every frame — `Fetch` never pauses a socket handshake, so none is screened, none is opened |

A refused top-level navigation or redirect is `X_DESIGN_URL_REFUSED`; refused subresources are listed by host in `reference.json` (`refused.hosts` inward, `refused.unresolved` a name that did not resolve — unreachable, not private, and asked again rather than cached). A dedicated worker's own socket and a `preconnect` TCP handshake are not covered. The resolve cannot pin Chrome's own socket: a name that rebinds between the screen and Chrome's lookup stays open, as for `@ultimat3/scraping`'s browser leg ([Known gaps](Known-Gaps)). There is no flag that admits loopback — the test suite reaches its fixture server through a harness-only option.

## `x shot --against`

| Reference | Pairs |
|---|---|
| `.x/design/<slug>` | every `shot-<width>-<scheme>.png` it holds, narrowed by `--viewport` / `--theme`; a pair asked for and not held is `X_SHOT_AGAINST_MISSING` |
| a `.png` | one pair: the one `--viewport` (else `1440x900`; more than one is `X_CLI_BAD_FLAG`), `--theme` (else `light`) |

The reference must lie under the app root or the current directory, through any link (`X_CLI_BAD_FLAG` otherwise).

Each pair is an ordinary route shot into `<out>/<width>-<scheme>/`, plus `diff-<width>-<scheme>.png` and an `against` block in its `verdict.json`: `similarity` (`1` identical, `0` every pixel changed), `changedPercent`, `changedBox`, `threshold` (`0.1`, `ui.diff`'s). Two heights compare on the larger canvas; what only one covers counts as changed. **Recorded, never gating**: `ok` is the shot's own verdict. Refused beside `--matrix`, `--island`, `--all-islands`.

## Dev MCP: `ui.research`

The same command (axiom 2), under `dev:test` like `ui.shot`: `{ urls: [1..5], follow?: 0..20 }` → the `--json` answer, artefacts in `<app>/.x/design/`. Same screen, same refusals. A cancelled call (`notifications/cancelled`) closes its browser, launches no further one and publishes nothing: `X_ABORTED`.

## Catalogues (`--list`)

| Source | Posture |
|---|---|
| React Bits | `ideas-only` — MIT + Commons Clause: watch the effect, never open the source |
| 21st.dev | `ideas-only` — per-component licences |
| Paper Shaders | `ideas-only` |
| shaders.com | `ideas-only` |
| reui | `mit-attribution` |
| shadcn/ui | `mit-attribution` |
| Motion | `mit-attribution` |

A host on no row is `ideas-only`. `mit-attribution` / `apache-notice` state what copying *would* owe; the framework's rule — ideas only — is stricter than all of them.

## Errors

| Code | When | Fix |
|---|---|---|
| `X_DESIGN_URL_REFUSED` | not `http(s)`, credentials, or the URL — or a redirect the page took — lands on a private, loopback or link-local address | a public `https://` page |
| `X_DESIGN_REFERENCE_UNREACHABLE` | navigation failed, timed out, answered 4xx/5xx, or the name did not resolve | `--timeout <ms>`, or drop the URL |
| `X_ABORTED` | the call was cancelled; nothing from the reference in progress was published | run it again |
| `X_SHOT_AGAINST_MISSING` | `--against` names no file, or a reference with no shot for that width and scheme | `x design research <url>` first |
