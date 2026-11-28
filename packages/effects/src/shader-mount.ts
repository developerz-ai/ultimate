// Our own WebGL2 mount: compile and link one program, feed it uniforms each frame, draw one
// full-screen triangle, survive a lost context, and give everything back on dispose. Techniques
// studied (IntersectionObserver/visibility pause, pixel cap, DPR floor, resize, dispose) — the
// code is written here. Pausing is `frameLoop`'s through the host; this file holds no GLSL.

import type { EffectHost } from './effect-host';
import { backingSize, EFFECT_PIXELS, type PixelBudget } from './pixel-budget';

/** One uniform: a float, or a float vector / vector array uploaded with the matching `*fv`. */
export type Uniform = readonly ['1f', number] | readonly ['2fv' | '3fv' | '4fv', Float32Array];

export interface ShaderFrame {
  /** Seconds of animation since frame 0, already scaled by speed. */
  readonly time: number;
  /** Backing-store pixels. */
  readonly width: number;
  readonly height: number;
  /** Backing pixels per CSS pixel: a shader sizing in CSS pixels multiplies by it. */
  readonly scale: number;
}

export interface ShaderProgram {
  /** GLSL ES 3.00. Drawn as `drawArrays(TRIANGLES, 0, 3)` with no attributes: use `gl_VertexID`. */
  readonly vertex: string;
  readonly fragment: string;
  readonly uniforms: (frame: ShaderFrame) => Readonly<Record<string, Uniform>>;
}

export interface ShaderMountOptions {
  readonly speed: number;
  readonly onLost: () => void;
  readonly onRestored: () => void;
  readonly budget?: PixelBudget | undefined;
}

export interface ShaderMount {
  readonly dispose: () => void;
}

export type ShaderMountResult =
  | { readonly ok: true; readonly mount: ShaderMount }
  | { readonly ok: false; readonly reason: 'no-context' | 'compile' | 'link' };

/** The longest step one frame may advance: a resumed tab continues, it does not leap. */
const MAX_STEP_MS = 100;

interface Linked {
  readonly program: WebGLProgram;
  readonly shaders: readonly WebGLShader[];
}

type Built = Linked | 'compile' | 'link';

function build(gl: WebGL2RenderingContext, source: ShaderProgram): Built {
  const shaders: WebGLShader[] = [];
  const release = (): void => {
    for (const shader of shaders) gl.deleteShader(shader);
  };
  for (const [type, text] of [
    [gl.VERTEX_SHADER, source.vertex],
    [gl.FRAGMENT_SHADER, source.fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (shader !== null) {
      shaders.push(shader);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
    }
    if (shader === null || gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      release();
      return 'compile';
    }
  }
  const program = gl.createProgram();
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    gl.deleteProgram(program);
    release();
    return 'link';
  }
  return { program, shaders };
}

function upload(gl: WebGL2RenderingContext, at: WebGLUniformLocation, uniform: Uniform): void {
  if (uniform[0] === '1f') gl.uniform1f(at, uniform[1]);
  else if (uniform[0] === '2fv') gl.uniform2fv(at, uniform[1]);
  else if (uniform[0] === '3fv') gl.uniform3fv(at, uniform[1]);
  else gl.uniform4fv(at, uniform[1]);
}

export function mountShader(
  canvas: HTMLCanvasElement,
  source: ShaderProgram,
  host: EffectHost,
  options: ShaderMountOptions,
): ShaderMountResult {
  const gl = canvas.getContext('webgl2');
  if (gl === null) return { ok: false, reason: 'no-context' };
  // `null` while there is no program: before the first build, and while the context is lost.
  let built: Linked | null = null;

  const budget = options.budget ?? EFFECT_PIXELS;
  const locations = new Map<string, WebGLUniformLocation | null>();
  let box: readonly [number, number] = [0, 0];
  let elapsed = 0;
  let last: number | undefined;
  let stopLoop: (() => void) | undefined;

  const draw = (): void => {
    if (built === null) return;
    const now = host.now();
    elapsed += last === undefined ? 0 : Math.min(now - last, MAX_STEP_MS) * options.speed;
    last = now;
    const size = backingSize(box[0], box[1], host.dpr(), budget);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    gl.viewport(0, 0, size.width, size.height);
    gl.useProgram(built.program);
    const frame = {
      time: elapsed / 1000,
      width: size.width,
      height: size.height,
      scale: size.scale,
    };
    for (const [name, uniform] of Object.entries(source.uniforms(frame))) {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(built.program, name));
      const at = locations.get(name);
      if (at !== null && at !== undefined) upload(gl, at, uniform);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const start = (): void => {
    last = undefined;
    stopLoop = host.motion.loop(draw, canvas);
  };
  const stop = (): void => {
    stopLoop?.();
    stopLoop = undefined;
  };
  const onLost = (event: Event): void => {
    // Without `preventDefault` the browser never offers the context back.
    event.preventDefault();
    stop();
    built = null;
    locations.clear();
    options.onLost();
  };
  const onRestored = (): void => {
    const rebuilt = build(gl, source);
    if (typeof rebuilt === 'string') return;
    built = rebuilt;
    start();
    options.onRestored();
  };

  // Listening BEFORE the first build: a context lost in between would otherwise read as a broken
  // shader, with no restore listener to bring it back.
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const first = gl.isContextLost() ? 'lost' : build(gl, source);
  // A lost context fails every compile, so a failure is the source's only on a live context.
  const outcome = typeof first === 'string' && gl.isContextLost() ? 'lost' : first;
  if (outcome === 'compile' || outcome === 'link') {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    // Nothing will draw on it: hand the context back now, not whenever GC finds it.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: false, reason: outcome };
  }
  const unobserve = host.observeSize(canvas, (width, height) => {
    box = [width, height];
  });
  if (outcome === 'lost') options.onLost();
  else {
    built = outcome;
    start();
  }

  return {
    ok: true,
    mount: {
      dispose: () => {
        stop();
        unobserve();
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        if (built !== null) {
          gl.deleteProgram(built.program);
          for (const shader of built.shaders) gl.deleteShader(shader);
        }
        // A page holds a handful of live contexts at most; hand this one back now, not at GC.
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      },
    },
  };
}
