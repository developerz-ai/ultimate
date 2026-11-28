# Motion

`@ultimat3/ui/motion`: one animation engine, the browser's own WAAPI, driven by the motion token
scale. Every engine is ours. No runtime dependency, and no second way to animate.

`As of 2026-11`. Stable API, semver from here ([Upgrading](Upgrading)). Issue #1374.

| Rule | Enforced by |
|---|---|
| Timing comes from tokens, never a literal | `motionTiming` reads `--duration-*` / `--easing-*`; the `raw-motion` guard refuses a literal duration or `cubic-bezier(` in app TS and SCSS |
| Reduced motion and the reader's pause still everything | `motionAllowed()` in every module; `reset.scss` and `theme.scss` for CSS |
| No layout property animates | `animate` frames accept none (a type error); `animated-layout-property` refuses one in `.animate(` keyframes and in SCSS |
| No second engine | the `motion-adapter` guard refuses `motion`, `framer-motion`, `gsap`, `animejs`, `solid-motionone`, `solid-transition-group`, … in app code |
| No bare frame loop | the `raw-frame-loop` guard refuses `requestAnimationFrame(` without a `// why:`; use `frameLoop` |
| A barrel island pays nothing for motion | `scripts/ui-motion-bytes.test.ts` pins zero motion modules, and a byte ceiling per entry |

## The API

```tsx
import {
  animate, frameLoop, inView, layout, motionAllowed, motionTiming,
  onMotionChange, Presence, PresenceList, scrollLinked, springLinear, springs, stagger,
} from '@ultimat3/ui/motion';
```

| Export | What it does |
|---|---|
| `motionTiming(duration, easing?)` | `{ duration, easing }` in WAAPI's units, from the RESOLVED custom properties, so `defineTheme({ motion })` applies. Stilled: `0.01` ms, never `0` (no finish event) |
| `animate(el, frames, options?)` | typed frames, `x` · `y` · `scale` · `scaleX` · `scaleY` · `rotate` · `opacity` · `filter` · `clipPath` · `origin` · `offset`, composed into one `transform`. Options: `duration` (a rung), `easing` (a rung or a spring), `delay`, `fill: 'backwards' \| 'both'`. Answers `{ finished, cancel, reverse }`; `finished` never rejects |
| `stagger(els, frames, { each, limit })` | each element starts one `each` (a duration rung, default `fast`) after the last; past `limit` (8) they start together |
| `inView(el, onEnter, { once, margin, amount })` | one shared `IntersectionObserver` per `(margin, amount)`. `once` defaults to `true`; with `once: false` a function `onEnter` returns is called on the exit. No observer: in view at once |
| `scrollLinked(el, frames, { source, axis, range })` | progress along a view timeline (the element crossing its viewport) or a scroll timeline, the engine behind CSS `animation-timeline`. Unsupported or stilled: the element rests |
| `layout(els, change, { scale })` | FLIP. Every box is read, `change()` runs, every box is read, then each moved element plays from its old place. `scale: true` also inverts size |
| `<Presence>` | enter and exit for one value. Props: `when`, `as`, `enter`, `exit`, `duration`, `easing`, `exitBeforeEnter`, `appear`, `onExit`, `class`. Owns its wrapper element; an exit is held until it finishes; turning back mid-flight reverses from the current value |
| `<PresenceList>` | the same for a keyed list: `each`, `key`, `as` (`ul` · `ol` · `div`), one root per key; a removed item exits in place |
| `frameLoop(tick, { el })` | the one per-frame loop. `tick(dt, now)`; stops on reduced motion, the reader's pause, a hidden tab, `el` offscreen; `dt` is 0 after any stop. Returns the stop |
| `motionAllowed()` · `onMotionChange(fn)` | false under `prefers-reduced-motion` or `html[data-motion="paused"]`; `fn(allowed)` on each change |
| `springs` · `springLinear({ stiffness, damping, mass })` | the rungs `gentle` · `snappy` · `bouncy`, committed as `linear()` curves and emitted as `--easing-<name>`; the generator for a rung of your own |

On the barrel, not the subpath: `MotionToggle`, the WCAG 2.2.2 pause. It writes
`data-motion="paused"` on `<html>`, remembers the choice, and stills every CSS animation and
transition plus every script above. In SCSS: `t.easing(snappy)` is a spring, and
`@include t.view-transition-name(post-#{$id})` names an element for render's route view transition.

```tsx
import { Card } from '@ultimat3/ui';
import { layout, Presence } from '@ultimat3/ui/motion';

declare const saved: () => boolean;
declare const cards: HTMLElement[];
declare const reorder: () => void;

export const toast = (
  <Presence when={saved()} easing="snappy">
    <Card>Saved</Card>
  </Presence>
);
layout(cards, reorder);
```

## From React and Motion

React islands are declined ([FAQ](FAQ#why-no-react-and-no-rsc)). What a Motion or shadcn
example reaches for, and what to write here:

| Motion / React | Ultimate |
|---|---|
| `motion.div animate={…}` | `animate(el, frames, { duration, easing })` |
| `transition={{ type: 'spring', stiffness, damping, mass }}` | `easing: 'gentle' \| 'snappy' \| 'bouncy'`, or `springLinear({ stiffness, damping, mass })` |
| `AnimatePresence` | `<Presence when>`; `mode="wait"` → `exitBeforeEnter`; `initial={false}` is the default (`appear` opts in) |
| `AnimatePresence` over a `.map()` | `<PresenceList each key>` |
| `layout` · `layoutId` | `layout(els, change)` in a page; `@include t.view-transition-name(…)` across pages |
| `whileInView` · `useInView` | `inView(el, onEnter, { once, margin, amount })` |
| `useScroll` + `useTransform` | `scrollLinked(el, frames, { source, range })` |
| `staggerChildren` · `stagger()` | `stagger(els, frames, { each })` |
| `useAnimationFrame` | `frameLoop(tick, { el })` |
| `useReducedMotion` · `MotionConfig reducedMotion` | `motionAllowed()` · `onMotionChange(fn)`; always on, nothing to configure |
| shadcn / Radix `Dialog`, `Sheet`, `Toast`, `Tooltip`, … | the `ui` component with the same job: `Dialog`, `Drawer`, `Toast`, `Tooltip` ([UI components](UI-Components)) |

## Why it is built, not wrapped

Motion's hybrid `animate` is 26.95 kB gzip, past an island's 20,480 B raw default. `motion/mini`
is plain WAAPI. Neither handles reduced motion on the vanilla path. Minified island bytes, `As of
2026-11-28`: `animate` 7,272 B, `inView` + `stagger` 8,866 B, `layout` 7,982 B, `frameLoop` 6,539 B alone, ~3.4 kB of each the coded error every ui component already ships.
The record: [build vs wrap](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/18-build-vs-wrap.md).
