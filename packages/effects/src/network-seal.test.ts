// Zero network, proved: every entry mounted as an island with `fetch`, `navigator.sendBeacon`,
// `XMLHttpRequest` and `WebSocket` replaced by a verdict that fails the test, then driven for
// 1,000 frames and unmounted. A hit is recorded as well as thrown, so an entry that swallowed the
// throw in a `.catch` still fails here.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fromMinor } from '@ultimat3/money';
import { Aurora } from './aurora/Aurora';
import { CountUp } from './count-up/CountUp';
import { EffectCanvas } from './effect-canvas/EffectCanvas';
import { GlassSurface } from './glass-surface/GlassSurface';
import { GradientOrbs } from './gradient-orbs/GradientOrbs';
import { GridGlow } from './grid-glow/GridGlow';
import { Marquee } from './marquee/Marquee';
import { MosaicGrid } from './mosaic-grid/MosaicGrid';
import { type FakePage, installFakePage, mountEntry } from './mount-harness-fixture';
import { Noise } from './noise/Noise';
import { ShaderBackground } from './shader-background/ShaderBackground';
import { Shimmer } from './shimmer/Shimmer';
import { SpotlightCard } from './spotlight-card/SpotlightCard';
import { TextReveal } from './text-reveal/TextReveal';
import { Tilt } from './tilt/Tilt';

const FRAMES = 1_000;
const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'] as const;

const hits: string[] = [];
const sealed = (name: string) =>
  function refused(): never {
    hits.push(name);
    return expect.unreachable(`an effect reached ${name}`);
  };

const scope = globalThis as Record<string, unknown>;
const saved = new Map<string, unknown>();
let page: FakePage | undefined;

beforeAll(() => {
  page = installFakePage();
  for (const name of NETWORK) {
    saved.set(name, scope[name]);
    scope[name] = sealed(name);
  }
  saved.set('navigator', scope['navigator']);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { sendBeacon: sealed('navigator.sendBeacon'), language: 'en' },
  });
});

afterAll(() => {
  for (const name of NETWORK) scope[name] = saved.get(name);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: saved.get('navigator'),
  });
  page?.restore();
});

const children = 'content';
const draw = () => (ctx: CanvasRenderingContext2D) => ctx.fillRect(0, 0, 1, 1);
/** `[name, component, props, whether it runs a frame loop]` — a loop entry that drew no frame was
 * not mounted, and a seal over nothing proves nothing. */
const ENTRIES: readonly (readonly [string, unknown, Record<string, unknown>, boolean, boolean?])[] =
  [
    ['Aurora', Aurora, { children }, false],
    ['GradientOrbs', GradientOrbs, { children }, false],
    ['MosaicGrid', MosaicGrid, { children }, true],
    ['GridGlow', GridGlow, { children, scanlines: true }, false],
    ['Noise', Noise, { children }, false],
    ['ShaderBackground mesh', ShaderBackground, { preset: 'mesh' }, true],
    ['ShaderBackground grain', ShaderBackground, { preset: 'grain' }, true],
    ['ShaderBackground dots', ShaderBackground, { preset: 'dots' }, true],
    // No WebGL2 on the canvas: the same entry on its Canvas2D fallback.
    ['ShaderBackground mesh, no WebGL2', ShaderBackground, { preset: 'mesh' }, true, false],
    ['EffectCanvas', EffectCanvas, { fallback: 'still', draw }, true],
    ['SpotlightCard', SpotlightCard, { children }, false],
    ['Tilt', Tilt, { children }, false],
    ['GlassSurface', GlassSurface, { children }, false],
    ['Marquee', Marquee, { children: () => children }, false],
    ['TextReveal', TextReveal, { text: 'Hello there, world' }, false],
    ['CountUp', CountUp, { value: fromMinor(12_345, 'EUR') }, true],
    ['Shimmer', Shimmer, { children }, false],
  ];

describe('network seal · every entry, 1,000 frames, no request', () => {
  for (const [name, component, props, loops, webgl2] of ENTRIES) {
    test(name, async () => {
      const before = hits.length;
      const unmount = mountEntry(component, props, { webgl2: webgl2 ?? true });
      // A lazy preset or mount resolves on a microtask: let it land before the frames run.
      await Bun.sleep(0);
      let ran = 0;
      for (let frame = 0; frame < FRAMES; frame++) ran += page?.frame() ?? 0;
      unmount();
      expect(hits.slice(before)).toEqual([]);
      if (loops) expect(ran).toBeGreaterThan(0);
    });
  }
});
