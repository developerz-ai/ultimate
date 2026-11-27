# 06 — Motion: `@ultimat3/ui/motion`

> Part of [`overview.md`](overview.md). Depends on: 02 (sweep 1 merged). Tier: 4 (`ui`), 5 (`cli` guards). Issue #1374, part 1.

Rule: one animation engine — the browser's WAAPI — driven by the motion token scale. Everything is
reimplemented here; reference libraries inspire ideas and techniques, never code. No runtime
dependency. Route transitions stay render's (`packages/render/src/navigation-dom.ts:133-154`,
already `startViewTransition`, skipped under reduced motion); `ui` adds names and timing in CSS only.

## Decisions (as of 2026-11, from the cloned sources)

| Question | Verdict | Evidence |
|---|---|---|
| Wrap `motion`? | **Build.** Hybrid `animate` is 26.95 kB gzip, over the 20,480 B raw island default (`packages/render/src/modes.ts:272`); `motion/mini` is plain WAAPI (3.2 kB gzip) and adds nothing over our own wrapper. Vanilla path has no reduced-motion handling. | `motion@14.14.0` `packages/framer-motion/package.json` `bundlesize` |
| Springs | **Write our own** spring → CSS `linear()` generator from the damped-oscillator equation (stiffness, damping, mass → sampled curve). Technique studied in Motion's `linear.ts`; no code ported. Emit spring rungs as `linear()` strings at token-build time: 0 B JS for a CSS spring. | technique only |
| `Presence` | Build on `ui`'s seven-function runtime (`packages/ui/src/theme/solid-adapter.ts:41-55`). `solid-transition-group` / `solid-motionone` need `@solid-primitives` + `children()`; not importable. `Presence` owns its wrapper element, so no child resolution. | prior art read in full (333 / 307 lines) |
| FLIP | Own ~100-line WAAPI FLIP; Motion's `animateLayout` pulls the projection system. | `motion-dom/src/layout/` |
| Subpath `./motion` vs barrel | Subpath, justified by measurement like `./icons/*` (`packages/ui/CLAUDE.md` "one import path" rule amended in the same PR). | `scripts/ui-barrel-bytes.test.ts` |
| Record | Build verdicts (rule: every engine is ours; references give ideas and techniques only) — three rows in `docs/idea/18-build-vs-wrap.md`. | — |

## Files to change

- `packages/ui/src/tokens/tokens.ts:77-93` — `springs` rungs `gentle | snappy | bouncy` (stiffness, damping, mass) + generated `linear()`; `SpringName` type.
- `packages/ui/src/tokens/_motion.scss:9-16` — `$spring` map from the same generator; `$easing.spring` cubic-bezier stays as the CSS fallback.
- `packages/ui/src/tokens/_mixins.scss:184` — `@mixin view-transition-name($name)`; `::view-transition-*` timing in `theme.scss`.
- `packages/ui/src/motion/` (new): `motion-timing.ts` (`motionTiming(name, easing?)` reads resolved `--duration-*`/`--easing-*` so `defineTheme({ motion })` applies), `animate.ts` (typed transform parts → WAAPI, `{ finished, cancel }`), `stagger.ts`, `in-view.ts` (one IntersectionObserver module), `scroll-linked.ts` (CSS `animation-timeline` where supported), `layout.ts` (FLIP, reads before writes), `Presence.tsx` + `presence-view.ts` (`<Presence when as enter exit exitBeforeEnter onExit>`), `PresenceList.tsx` (one `createRoot` per key, as `data-table-rows.ts`), `frame-loop.ts` (`frameLoop(tick, { el })` stops on reduced motion, `document.hidden`, offscreen, user pause — the twin of `visibleInterval()`), `motion-gate.ts` (`motionAllowed()`, `onMotionChange()`: `matchMedia` + `html[data-motion="paused"]`; the JS half of `reset.scss:155-167`), `index.ts`.
- `packages/ui/src/components/MotionToggle.tsx` — WCAG 2.2.2 pause, sets `data-motion`; barrel export.
- `packages/ui/src/ui-keys.ts`, `packages/i18n/src/catalogs/en.json` — `ui.motion.pause`, `ui.motion.resume` (+ ro/es/pt-BR framework catalogs, `bun run i18n` parity).
- `packages/ui/package.json:36-43` — `"./motion": "./src/motion/index.ts"`.
- `packages/cli/src/templates/guard-raw-motion.ts:224-229` — also scan `{apps,packages}/**/*.{ts,tsx}`: numeric `duration`/`delay` in `.animate(`, `cubic-bezier(` strings. Move the snapping table (`durationFor`, `:107-116`, today inside a template string) to a shared module `packages/cli/src/templates/motion-scale.ts`, reused by 08.
- `packages/cli/src/templates/guard-animated-layout-property.ts` — same TS scan for layout keys in keyframe objects; fix names `layout()`.
- New guards `guard-motion-adapter.ts` (refuses direct `motion`, `motion-dom`, `framer-motion`, `gsap`, `animejs`, `solid-motionone`, `solid-transition-group`, `@paper-design/shaders`, `shaders`, `ogl`, `three` in app code) and `guard-raw-frame-loop.ts` (bare `requestAnimationFrame(`; `// why:` admits, as `raw-interval`); register in `guards-shipped-names.ts`, `scaffold-guards.ts:67-95`; `bun run scripts/guards-doc.ts --write`.
- `scripts/ui-barrel-bytes.test.ts` — barrel-only island has zero motion bytes; per-entry ceilings for `./motion`.
- `packages/ui/{README,CLAUDE,CATALOG}.md` — `ui/CLAUDE.md` is 24,317 B vs its 24 KB pin: move history to `docs/history/ui.md` in the same PR.
- `wiki/Motion.md` (new) — API + the mapping table: `AnimatePresence` → `Presence`, `layout`/`layoutId` → `layout()` / view-transition names, `whileInView` → `inView`, `useScroll` → `scrollLinked`, `staggerChildren` → `stagger`, shadcn/Radix → the `ui` component of the same job. Closes #1374 checkbox 2 (Solid mapping; React islands declined, `wiki/FAQ.md:60`).
- `examples/dummy/**` — `Presence` on `app/posts/board` cards, `layout()` on reorder, `stagger` + `inView` on `app/feed`; each touched route restates its budget with a `// measured:` line (`bun run budget-raises`).

## Steps

1. Measure first: island bundle bytes for `motionTiming`, `animate`, `Presence`, `layout`, `inView`+`stagger`, the full adapter (`bun run x -- build --json --cwd examples/dummy`). Record numbers in the PR body.
2. Tokens + generator (slice A). Then the motion module.
3. Guards (slice B). New guards ship `severity: 'warning'` in existing apps (a stricter rule is a break, `wiki/Stability.md:28`); `x new` writes `"error"` rows into `guards/shipped.json`. Census the three tracked apps before turning the TS scans on.
4. Docs + reference app (slices C, D).
5. Later sweep (not this PR): migrate `Dialog` (`Dialog.module.scss:3`), `Drawer`, `Toast`, modal (`global.scss:141`) keyframes onto `Presence`.

## Tests

- `packages/ui/src/motion/motion-timing.test.ts` — theme override read; reduced motion yields `$still`, never 0.
- `presence-view.test.ts` — exit holds the node; re-enter mid-exit reverses from current value; dispose cleans up; inert SSR render (`INERT_SOLID_RUNTIME`).
- `layout.test.ts` (FLIP inversion maths, batched reads), `frame-loop.test.ts` (four independent stop reasons, injected clock, `fake-dom.ts`), `spring-linear.test.ts` (generator output vs a known curve).
- Each guard test: the failing case first, then lookalikes (`guard-*.test.ts`); `scaffold-guards-style.test.ts` runs them over `packages/ui`.
- `bun test ./packages/ui/src/motion/`, `bun test ./packages/cli/src/templates/guard-raw-motion.test.ts`.

## Done when

- `examples/dummy` uses spring, stagger, enter/exit and layout animation through `@ultimat3/ui/motion` and passes the app gate. (The fresh-scaffold check — #1374 checkbox 1 — is slice 09's, after scaffold adoption.)
- `raw-motion` catches a literal duration in TS; the adapter's calls are silent.
- Barrel-only islands carry zero motion bytes (pinned).
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
