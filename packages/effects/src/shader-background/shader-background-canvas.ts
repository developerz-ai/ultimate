// ShaderBackground on Canvas2D, for an island without WebGL2: the same `meshPoints`, `grainAngle`
// and `dotsRamp` the GLSL reads, drawn with gradients and arcs. Grain's film texture stays the
// server's SVG overlay here; the shader draws its own.

import type { CanvasDraw } from '../canvas-mount';
import { cssRgb, type Rgb } from '../palette';
import {
  DOT_PITCH,
  DOT_RADIUS,
  dotsRamp,
  grainAngle,
  MESH_PEAK,
  MESH_RADIUS,
  meshPoints,
  type ShaderPreset,
} from './shader-background-view';

/** `1 - smoothstep` sampled at quarters: the stops the server's `radial-gradient`s use too. */
export const MESH_STOPS: readonly (readonly [number, number])[] = [0, 0.25, 0.5, 0.75, 1].map(
  (x) => [x, MESH_PEAK * (1 - x * x * (3 - 2 * x))] as const,
);

const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const drawMesh =
  (colours: () => readonly Rgb[]): CanvasDraw =>
  (ctx, frame) => {
    const palette = colours();
    const ground = palette[0];
    if (ground === undefined) return;
    ctx.fillStyle = cssRgb(ground);
    ctx.fillRect(0, 0, frame.width, frame.height);
    meshPoints(frame.time).forEach(([x, y], index) => {
      const colour = palette[index + 1];
      if (colour === undefined) return;
      // A unit circle stretched to the ellipse: `ellipse 60% 60%` is 60% of EACH axis.
      ctx.setTransform(
        frame.scale * MESH_RADIUS * frame.width,
        0,
        0,
        frame.scale * MESH_RADIUS * frame.height,
        frame.scale * x * frame.width,
        frame.scale * y * frame.height,
      );
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const [offset, alpha] of MESH_STOPS)
        gradient.addColorStop(offset, cssRgb(colour, alpha));
      ctx.fillStyle = gradient;
      ctx.fillRect(-1, -1, 2, 2);
    });
    ctx.setTransform(frame.scale, 0, 0, frame.scale, 0, 0);
  };

const drawGrain =
  (colours: () => readonly Rgb[]): CanvasDraw =>
  (ctx, frame) => {
    const [, a, b] = colours();
    if (a === undefined || b === undefined) return;
    const angle = (grainAngle(frame.time) * Math.PI) / 180;
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    // CSS's gradient line: through the centre, long enough to reach both far corners.
    const half = (Math.abs(frame.width * dx) + Math.abs(frame.height * dy)) / 2;
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const gradient = ctx.createLinearGradient(
      cx - dx * half,
      cy - dy * half,
      cx + dx * half,
      cy + dy * half,
    );
    gradient.addColorStop(0, cssRgb(a));
    gradient.addColorStop(1, cssRgb(b));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, frame.width, frame.height);
  };

const drawDots =
  (colours: () => readonly Rgb[]): CanvasDraw =>
  (ctx, frame) => {
    const [ground, a, b] = colours();
    if (ground === undefined || a === undefined || b === undefined) return;
    ctx.fillStyle = cssRgb(ground);
    ctx.fillRect(0, 0, frame.width, frame.height);
    const ramp = dotsRamp(frame.time);
    const cols = Math.ceil(frame.width / DOT_PITCH);
    const rows = Math.ceil(frame.height / DOT_PITCH);
    const centreX = frame.width / 2 / DOT_PITCH;
    const centreY = frame.height / 2 / DOT_PITCH;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const wave = Math.sin(Math.hypot(col - centreX, row - centreY) * 0.35 - frame.time * 1.6);
        const hue = ramp * (0.5 + 0.5 * Math.sin(col * 0.3 + row * 0.2 + frame.time * 0.8));
        ctx.fillStyle = cssRgb(lerp(a, b, hue));
        ctx.beginPath();
        ctx.arc(
          (col + 0.5) * DOT_PITCH,
          (row + 0.5) * DOT_PITCH,
          DOT_RADIUS * (1 + ramp * 0.7 * wave),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
  };

export function presetCanvas(preset: ShaderPreset, colours: () => readonly Rgb[]): CanvasDraw {
  if (preset === 'mesh') return drawMesh(colours);
  if (preset === 'grain') return drawGrain(colours);
  return drawDots(colours);
}
