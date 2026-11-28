// The Canvas2D twin of `shader-mount.ts`: the same clock, pixel budget and frame loop, drawing
// with a function instead of a program. What an island without WebGL2 animates with, and what
// `EffectCanvas` hands an app's own `draw`.

import type { EffectHost } from './effect-host';
import { backingSize, EFFECT_PIXELS, type PixelBudget } from './pixel-budget';

export interface CanvasFrame {
  /** Seconds of animation since frame 0, already scaled by speed. */
  readonly time: number;
  /** CSS pixels: the context is pre-scaled, so a draw never multiplies by the ratio itself. */
  readonly width: number;
  readonly height: number;
  /** Backing pixels per CSS pixel, already applied to the context's transform. */
  readonly scale: number;
}

export type CanvasDraw = (ctx: CanvasRenderingContext2D, frame: CanvasFrame) => void;

export interface CanvasMountOptions {
  readonly speed: number;
  readonly budget?: PixelBudget | undefined;
}

const MAX_STEP_MS = 100;

/** `undefined` when the canvas has no 2D context to give (already WebGL's, or none at all). */
export function mountCanvas(
  canvas: HTMLCanvasElement,
  draw: CanvasDraw,
  host: EffectHost,
  options: CanvasMountOptions,
): (() => void) | undefined {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return undefined;
  const budget = options.budget ?? EFFECT_PIXELS;
  let box: readonly [number, number] = [0, 0];
  let elapsed = 0;
  let last: number | undefined;

  const tick = (): void => {
    const now = host.now();
    elapsed += last === undefined ? 0 : Math.min(now - last, MAX_STEP_MS) * options.speed;
    last = now;
    const size = backingSize(box[0], box[1], host.dpr(), budget);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    ctx.setTransform(size.scale, 0, 0, size.scale, 0, 0);
    ctx.clearRect(0, 0, box[0], box[1]);
    draw(ctx, { time: elapsed / 1000, width: box[0], height: box[1], scale: size.scale });
  };

  const unobserve = host.observeSize(canvas, (width, height) => {
    box = [width, height];
  });
  const stop = host.motion.loop(tick, canvas);
  return () => {
    stop();
    unobserve();
  };
}
