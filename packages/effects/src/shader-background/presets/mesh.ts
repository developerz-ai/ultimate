// The `mesh` preset's GLSL, written for Ultimate: three role colours laid over a ground as soft
// ellipses whose centres follow `meshPoints(t)`, with a value-noise warp that grows in from zero.
// At frame 0 it is exactly the server's layered `radial-gradient` frame. Its own lazy chunk.

import type { Rgb } from '../../palette';
import type { ShaderProgram } from '../../shader-mount';
import { MESH_PEAK, MESH_RADIUS, meshPoints } from '../shader-background-view';
import { packColours } from '../uniform-pack';

// Duplicated in each preset on purpose: a shared module would be a fourth chunk every preset
// loads, for 180 bytes. One triangle covering the viewport, no vertex buffer (`gl_VertexID`).
const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_colors[4];
uniform vec2 u_points[3];
out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) / u_resolution;
  float warp = 0.06 * smoothstep(0.0, 3.0, u_time);
  uv += warp * (vec2(
    valueNoise(uv * 3.0 + u_time * 0.07),
    valueNoise(uv * 3.0 + 9.0 - u_time * 0.05)
  ) - 0.5);
  vec3 colour = u_colors[0];
  for (int i = 0; i < 3; i++) {
    float d = length((uv - u_points[i]) / ${MESH_RADIUS.toFixed(3)});
    colour = mix(colour, u_colors[i + 1], ${MESH_PEAK.toFixed(3)} * (1.0 - smoothstep(0.0, 1.0, d)));
  }
  fragColor = vec4(colour, 1.0);
}`;

export function meshProgram(colours: () => readonly Rgb[]): ShaderProgram {
  const palette = new Float32Array(12);
  const points = new Float32Array(6);
  const resolution = new Float32Array(2);
  return {
    vertex: VERTEX,
    fragment: FRAGMENT,
    uniforms: (frame) => {
      meshPoints(frame.time).forEach((point, index) => {
        points.set(point, index * 2);
      });
      resolution.set([frame.width, frame.height]);
      return {
        u_resolution: ['2fv', resolution],
        u_time: ['1f', frame.time],
        u_colors: ['3fv', packColours(colours(), palette)],
        u_points: ['2fv', points],
      };
    },
  };
}
