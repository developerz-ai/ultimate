// What every animated entry's island effect calls: resolve the role palette, pick the backend,
// mount the richest context it got (WebGL2 → Canvas2D → the server frame), relabel on a pause or a
// lost context, and give everything back on unmount. The `.tsx` holds markup; this holds the rule.

import type { ColorRole } from '@ultimat3/ui';
import { type EffectBackend, type EffectWants, pickBackend } from './backend';
import { type CanvasDraw, mountCanvas } from './canvas-mount';
import { pauseOffscreen } from './css-pause';
import type { EffectHost } from './effect-host';
import { type Rgb, resolvePalette } from './palette';
import type { ShaderLoad } from './shader-load';

export interface EffectSpec {
  /** Whether the entry's server frame animates in CSS. */
  readonly css: boolean;
  readonly wants: EffectWants;
  readonly speed: number;
  readonly roles: readonly ColorRole[];
  /** Lazy (`loadShader`), so the GLSL and the WebGL2 mount reach only an island that draws them. */
  readonly shader?: ((colours: () => readonly Rgb[]) => Promise<ShaderLoad>) | undefined;
  readonly draw2d?: ((colours: () => readonly Rgb[]) => CanvasDraw) | undefined;
  /** Pause the CSS animation offscreen and in a hidden tab (`data-effect-paused`). */
  readonly pauseCss?: boolean | undefined;
}

/** Why a richer backend was not used, written to `data-effect-fallback` for whoever debugs it. */
type Fallback = 'compile' | 'link' | 'load';

export function mountEffect(
  root: HTMLElement,
  canvas: HTMLCanvasElement | undefined,
  spec: EffectSpec,
  host: EffectHost,
  label: (backend: EffectBackend) => void,
): () => void {
  let colours = resolvePalette(host, root, spec.roles);
  const current = (): readonly Rgb[] => colours ?? [];
  const state = { webgl2: false, canvas: false, lost: false, loading: false, done: false };
  let release: (() => void) | undefined;

  const relabel = (): void =>
    label(
      pickBackend({
        motion: host.motion.allowed(),
        hydrated: true,
        css: spec.css,
        wants: spec.wants,
        webgl2: state.webgl2,
        canvas: state.canvas,
        lost: state.lost,
      }),
    );
  const fallBack = (why: Fallback): void => root.setAttribute('data-effect-fallback', why);
  const tryCanvas = (target: HTMLCanvasElement): void => {
    if (spec.draw2d === undefined) return;
    release = mountCanvas(target, spec.draw2d(current), host, { speed: spec.speed });
    state.canvas = release !== undefined;
  };
  const tryShader = (target: HTMLCanvasElement, load: NonNullable<EffectSpec['shader']>): void => {
    state.loading = true;
    load(current)
      .then(({ program, mount }) => {
        if (state.done) return;
        const result = mount(target, program, host, {
          speed: spec.speed,
          onLost: () => {
            state.lost = true;
            relabel();
          },
          onRestored: () => {
            state.lost = false;
            relabel();
          },
        });
        if (result.ok) {
          state.webgl2 = true;
          release = result.mount.dispose;
        } else if (result.reason === 'no-context') tryCanvas(target);
        else fallBack(result.reason);
      })
      .catch(() => fallBack('load'))
      .finally(() => {
        state.loading = false;
        if (!state.done) relabel();
      });
  };
  // Mounts at most once: a pause after that is `frameLoop`'s, and only the label changes.
  const ensure = (): void => {
    if (canvas === undefined || spec.wants === 'css' || release !== undefined) return;
    if (state.loading || colours === undefined || !host.motion.allowed()) return;
    if (spec.wants === 'webgl2' && spec.shader !== undefined) tryShader(canvas, spec.shader);
    else tryCanvas(canvas);
  };

  const unsubscribe = host.motion.onChange(() => {
    relabel();
    ensure();
  });
  const unTheme = host.observeTheme(() => {
    colours = resolvePalette(host, root, spec.roles) ?? colours;
    ensure();
  });
  const unVisible = spec.pauseCss === true ? pauseOffscreen(root, host.observeVisible) : undefined;
  ensure();
  relabel();

  return () => {
    state.done = true;
    release?.();
    unsubscribe();
    unTheme();
    unVisible?.();
  };
}
