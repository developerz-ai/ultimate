# @ultimat3/effects

Server-rendered-first visual effects for Ultimate apps: six backgrounds, seven interaction and
text effects, and `EffectCanvas` for your own. Every entry renders a real frame on the server,
works with scripting off, honours reduced motion and `MotionToggle`, draws colour from role tokens
only, and makes zero network requests. Apps that never import it pay 0 B.

```sh
bun add @ultimat3/effects
```

```tsx
import { Aurora, ShaderBackground } from '@ultimat3/effects';

<Aurora intensity={0.6}><h1>{t('home.title')}</h1></Aurora>   // CSS only: 0 B JS on a site/ page
<ShaderBackground preset="mesh">…</ShaderBackground>           // island: WebGL2, else Canvas2D, else the frame
```

Guide: [Effects](https://github.com/developerz-ai/ultimate/wiki/Effects) · props: [CATALOG.md](CATALOG.md).

## The tier contract

Every root carries `data-effect-backend`:

| Value | When |
|---|---|
| `static` | reduced motion, `html[data-motion="paused"]`, or an entry whose frame does not animate |
| `css` | the server frame animates in CSS (any page, any island before it mounts) |
| `canvas` | an island with no WebGL2 (or an entry that only draws 2D) |
| `webgl2` | an island whose WebGL2 context compiled the program and is not lost |

## What it owns

| Module | Owns |
|---|---|
| `src/backend.ts` | the one backend decision (`pickBackend`) |
| `src/shader-mount.ts` | our WebGL2 mount: compile/link, uniforms, one full-screen triangle, context loss and restore, dispose. No GLSL |
| `src/canvas-mount.ts` | the Canvas2D twin: same clock, budget and loop |
| `src/effect-mount.ts` | what every animated entry's island effect calls: palette → backend → mount → relabel → release |
| `src/use-effect-mount.ts` | the Solid shell around it (signal + refs + one effect) |
| `src/effect-host.ts` · `src/motion-port.ts` | the browser, injected; the one door to `@ultimat3/ui/motion` |
| `src/pixel-budget.ts` | `EFFECT_PIXELS`: the DPR floor, DPR cap and pixel ceiling, one token |
| `src/palette.ts` · `src/props.ts` | resolved role channels; the prop screens (`X_EFFECTS_INVALID_VALUE`) |
| `src/<entry>/` | `<Name>.tsx` (markup) + `<Name>.module.scss` + `<name>-view.ts` (the rules, pure) |
| `src/shader-background/presets/` | one GLSL ES 3.00 program per preset, each its own lazy chunk |

## Boundary

Tier 5. Imports `@ultimat3/core`, `@ultimat3/money`, `@ultimat3/ui` (and `@ultimat3/ui/motion`).
Enforced by `bun run boundaries`.

## Errors

`X_EFFECTS_INVALID_VALUE` — a prop outside the range the entry can draw. "No WebGL2" is never an
error: it is a backend.
