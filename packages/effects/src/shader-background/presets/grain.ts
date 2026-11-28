// The `grain` preset's GLSL, written for Ultimate: a two-role linear gradient at `grainAngle(t)`,
// placed exactly as CSS places `linear-gradient(<angle>, a, b)` (the corner-to-corner gradient
// line), with per-CSS-pixel film grain that changes 24 times a second. Its own lazy chunk.

import type { Rgb } from '../../palette';
import type { ShaderProgram } from '../../shader-mount';
import { grainAngle } from '../shader-background-view';
import { packColours } from '../uniform-pack';

// Duplicated in each preset on purpose: see `mesh.ts`.
const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_scale;
uniform float u_angle;
uniform vec3 u_colors[4];
out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - 0.5 * u_resolution;
  vec2 dir = vec2(sin(u_angle), -cos(u_angle));
  float span = abs(u_resolution.x * dir.x) + abs(u_resolution.y * dir.y);
  float t = clamp(dot(p, dir) / span + 0.5, 0.0, 1.0);
  vec3 colour = mix(u_colors[1], u_colors[2], t);
  float grain = hash(floor(gl_FragCoord.xy / u_scale) + floor(u_time * 24.0)) - 0.5;
  fragColor = vec4(colour + grain * 0.08, 1.0);
}`;

export function grainProgram(colours: () => readonly Rgb[]): ShaderProgram {
  const palette = new Float32Array(12);
  const resolution = new Float32Array(2);
  return {
    vertex: VERTEX,
    fragment: FRAGMENT,
    uniforms: (frame) => {
      resolution.set([frame.width, frame.height]);
      return {
        u_resolution: ['2fv', resolution],
        u_time: ['1f', frame.time],
        u_scale: ['1f', frame.scale],
        u_angle: ['1f', (grainAngle(frame.time) * Math.PI) / 180],
        u_colors: ['3fv', packColours(colours(), palette)],
      };
    },
  };
}
