# Research — prior art and references (as of 2026-11-27)

> Reference for [`overview.md`](overview.md); not a slice. Reference sources were read from shallow
> clones and live pages; no third-party code or pixels are committed.

## Motion in other frameworks

| Who | Enter/exit | List / FLIP | Spring | Route | Reduced motion |
|---|---|---|---|---|---|
| Svelte | `transition:` directives; compiler defers unmount | `animate:flip` | `Spring`/`Tween` | — | store, not automatic |
| Vue | `<Transition>` classes | `<TransitionGroup>` | — | wrap router view | manual |
| Angular | `animate.enter/leave` CSS classes; `@angular/animations` deprecated 20.2 | — | — | router view transitions | manual |
| Astro | View Transitions | `transition:name` | — | `<ClientRouter>` | automatic |
| React 19.3 | `<ViewTransition>` | shared name | — | yes | CSS |
| Motion | `AnimatePresence` (React) | `layout` | real springs | — | React path only |
| solid-transition-group 0.3.0 | CSS classes, `onExit(el, done)` | FLIP via rects | — | — | none |
| solid-motionone 1.0.4 | `<Presence>` over legacy Motion One | weak | via engine | — | none |

Takeaways: a major framework (Angular) dropped its JS animation DSL for native CSS; nobody makes
reduced motion the default for JS; exit-before-unmount and mid-exit interruption are the pitfalls.
Motion's bundle ceilings (gzip, `framer-motion/package.json`): hybrid `animate` 26.95 kB, `animateMini`
3.2 kB, `scroll` 3.75 kB. → [`06-motion.md`](06-motion.md).

## Effect libraries

Rule: we reimplement everything; these inspire ideas and techniques only — no dependency, no copied code.

| Who | Licence | Engine | Built-in perf | Verdict |
|---|---|---|---|---|
| Paper Shaders 0.0.82 | Apache-2.0 | vanilla WebGL2, 0 deps | offscreen + hidden pause, pixel caps | **techniques studied** (mount lifecycle, pause, pixel cap) |
| shaders.com (`shaders` 4.0.7) | MIT | WebGPU (`typegpu`) | offscreen 1 FPS | telemetry on by default (hostname, 5%) — ideas only |
| React Bits | MIT + Commons Clause (no ported redistribution) | React + ogl/three/gsap/motion | reduced motion in 370/832 files | clean-room ideas only |
| Magic UI, Aceternity | MIT / per-item | React + Motion | per component | reference only |
| ogl | Unlicense | minimal WebGL | none | not needed |

Measured from two 21st.dev dashboard bundles: plain CSS keyframes with staggered delays (in 350–400 ms,
grow 700 ms, draw 900 ms, ping 1.6 s), 4 `backdrop-filter` layers `blur(5–15px)`, one custom ease
`cubic-bezier(.24,.89,.26,1)` at 0.36 s, Manrope / system-ui. All reachable with tokens + 06 + 07.
→ [`07-effects.md`](07-effects.md).

## AI design-reference workflows

| Who | Input | Extraction | Verification |
|---|---|---|---|
| v0, Lovable | screenshot / URL screenshot | vision only | human |
| Google Stitch | URL crawl | computed styles → `DESIGN.md` | human |
| dembrandt (OSS) | URL | Playwright computed styles → W3C design tokens | none |
| screenshot-to-code | screenshot | vision | re-screenshot loop |

Gap nobody fills: measured tokens mapped onto the target design system plus a mechanical compare.
→ [`08-design-research.md`](08-design-research.md), [`09-agent-kit.md`](09-agent-kit.md).

## Bug-adjacent prior art

| Topic | Others | Ultimate choice |
|---|---|---|
| Unknown input keys | Zod/Valibot strip by default with strict variants; Fastify strips only where schema says `additionalProperties:false`; some payment APIs reject | one behaviour matching the published schema: reject — on `next` (#1281) |
| Live resume trust | Replicache CVR server-side; Electric `offset`+`handle`, unknown ⇒ refetch; none trusts client row sets | HMAC-signed stateless cursor (#1280) |
| OTel identity | spec: `OTEL_SERVICE_NAME` > `OTEL_RESOURCE_ATTRIBUTES` > default `unknown_service` | same order, then app name (#1361) |
| Flakes | quarantine+retry (Google) vs fix-or-delete | keep no-retry; fix order dependence |
| Release trains | Angular/Node develop forward + backport | keep forward-merge to `next`; token with `workflows` write |

## Sources

Motion: motion.dev/docs/feature-comparison · react.dev/reference/react/ViewTransition ·
angular.dev/guide/animations/migration · docs.astro.build/en/guides/client-side-routing ·
github.com/solidjs-community/solid-transition-group · github.com/paper-design/shaders ·
shaders.com/docs/guide/telemetry · github.com/DavidHDev/react-bits (LICENSE.md) ·
github.com/dembrandt/dembrandt · zod.dev/v4/changelog · ajv.js.org/guide/modifying-data.html ·
doc.replicache.dev/strategies/row-version · electric-sql.com/docs/api/http ·
opentelemetry.io/docs/specs/otel/configuration/SDK-environment-variables
