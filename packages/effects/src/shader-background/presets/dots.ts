// The `dots` preset's GLSL, written for Ultimate: a dot grid on the CSS frame's pitch whose radius
// ripples outward from the centre and whose hue drifts between two roles — both scaled by
// `dotsRamp(t)`, so frame 0 is the server's uniform `radial-gradient` grid. Its own lazy chunk.

import type { Rgb } from '../../palette';
import type { ShaderProgram } from '../../shader-mount';
import { DOT_PITCH, DOT_RADIUS, dotsRamp } from '../shader-background-view';
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
uniform float u_ramp;
uniform vec3 u_colors[4];
out vec4 fragColor;

const float PITCH = ${DOT_PITCH.toFixed(3)};
const float RADIUS = ${DOT_RADIUS.toFixed(3)};

void main() {
  vec2 px = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) / u_scale;
  vec2 cell = floor(px / PITCH);
  vec2 local = mod(px, PITCH) - 0.5 * PITCH;
  vec2 centre = 0.5 * u_resolution / u_scale / PITCH;
  float wave = sin(length(cell - centre) * 0.35 - u_time * 1.6);
  float radius = RADIUS * (1.0 + u_ramp * 0.7 * wave);
  float coverage = 1.0 - smoothstep(radius - 0.5, radius + 0.5, length(local));
  float hue = u_ramp * (0.5 + 0.5 * sin(cell.x * 0.3 + cell.y * 0.2 + u_time * 0.8));
  vec3 ink = mix(u_colors[1], u_colors[2], hue);
  fragColor = vec4(mix(u_colors[0], ink, coverage), 1.0);
}`;

export function dotsProgram(colours: () => readonly Rgb[]): ShaderProgram {
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
        u_ramp: ['1f', dotsRamp(frame.time)],
        u_colors: ['3fv', packColours(colours(), palette)],
      };
    },
  };
}
