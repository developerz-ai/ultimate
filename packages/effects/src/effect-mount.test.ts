import { describe, expect, test } from 'bun:test';
import type { EffectBackend } from './backend';
import { type EffectSpec, mountEffect } from './effect-mount';
import { asCanvas, asElement, FakeCanvas, FakeHost, FakeRoot } from './fake-host-fixture';
import type { Rgb } from './palette';
import { mountShader, type ShaderProgram } from './shader-mount';

const program = (colours: () => readonly Rgb[]): ShaderProgram => ({
  vertex: 'v',
  fragment: 'f',
  uniforms: () => ({ u_c0: ['3fv', new Float32Array(colours()[0] ?? [])] }),
});

const SHADER: EffectSpec = {
  css: false,
  wants: 'webgl2',
  speed: 1,
  roles: ['accent'],
  shader: async (colours) => ({ program: program(colours), mount: mountShader }),
  draw2d: () => (ctx) => ctx.fillRect(0, 0, 1, 1),
};

interface Rig {
  readonly root: FakeRoot;
  readonly canvas: FakeCanvas;
  readonly host: FakeHost;
  readonly labels: EffectBackend[];
  readonly stop: () => void;
}

const rig = async (spec: EffectSpec, prepare?: (r: Omit<Rig, 'stop' | 'labels'>) => void) => {
  const root = new FakeRoot();
  const canvas = new FakeCanvas();
  const host = new FakeHost();
  prepare?.({ root, canvas, host });
  const labels: EffectBackend[] = [];
  const stop = mountEffect(asElement(root), asCanvas(canvas), spec, host, (b) => labels.push(b));
  await Bun.sleep(0);
  return { root, canvas, host, labels, stop };
};

describe('unit · effect mount', () => {
  test('an island with WebGL2 loads the program and labels webgl2', async () => {
    const r = await rig(SHADER);
    expect(r.labels.at(-1)).toBe('webgl2');
    r.host.frame();
    expect(r.canvas.gl?.count('drawArrays')).toBe(1);
  });

  test('no WebGL2: the same entry draws on Canvas2D', async () => {
    const r = await rig(SHADER, ({ canvas }) => {
      canvas.gl = null;
    });
    expect(r.labels.at(-1)).toBe('canvas');
    r.host.frame();
    expect(r.canvas.ctx?.calls.some((c) => c[0] === 'fillRect')).toBe(true);
  });

  test('neither context: the frame stays, labelled static', async () => {
    const r = await rig(SHADER, ({ canvas }) => {
      canvas.gl = null;
      canvas.ctx = null;
    });
    expect(r.labels.at(-1)).toBe('static');
  });

  test('a shader that will not compile keeps the frame and says why on the root', async () => {
    const r = await rig(SHADER, ({ canvas }) => {
      if (canvas.gl) canvas.gl.compiles = false;
    });
    expect(r.labels.at(-1)).toBe('static');
    expect(r.root.getAttribute('data-effect-fallback')).toBe('compile');
  });

  test('a program that fails to load keeps the frame and says why', async () => {
    const r = await rig({ ...SHADER, shader: () => Promise.reject(new TypeError('chunk 404')) });
    expect(r.labels.at(-1)).toBe('static');
    expect(r.root.getAttribute('data-effect-fallback')).toBe('load');
  });

  test('reduced motion at mount: static, and nothing is compiled until motion is allowed', async () => {
    const r = await rig(SHADER, ({ host }) => {
      host.allowedNow = false;
    });
    expect(r.labels).toEqual(['static']);
    expect(r.canvas.gl?.count('createProgram')).toBe(0);
    r.host.setMotion(true);
    await Bun.sleep(0);
    expect(r.labels.at(-1)).toBe('webgl2');
  });

  test('a pause mid-run relabels static, and resuming relabels webgl2 without recompiling', async () => {
    const r = await rig(SHADER);
    r.host.setMotion(false);
    expect(r.labels.at(-1)).toBe('static');
    r.host.setMotion(true);
    expect(r.labels.at(-1)).toBe('webgl2');
    expect(r.canvas.gl?.count('createProgram')).toBe(1);
  });

  test('a lost context shows the frame; a restored one draws again', async () => {
    const r = await rig({ ...SHADER, css: true });
    r.canvas.dispatch('webglcontextlost');
    expect(r.labels.at(-1)).toBe('css');
    r.canvas.dispatch('webglcontextrestored');
    expect(r.labels.at(-1)).toBe('webgl2');
  });

  test('a theme change re-reads the role channels the shader draws with', async () => {
    const r = await rig(SHADER);
    r.host.frame();
    r.host.setTheme(() => '255 0 0');
    r.host.frame();
    const colours = r.canvas.gl?.calls.filter((c) => c[0] === 'uniform').map((c) => c[2]);
    expect(colours?.[0]).toEqual([120 / 255, 80 / 255, 200 / 255].map(Math.fround));
    expect(colours?.[1]).toEqual([1, 0, 0]);
  });

  test('an unthemed page (no role channels) never mounts a canvas', async () => {
    const r = await rig(SHADER, ({ host }) => {
      host.vars = () => '';
    });
    expect(r.labels.at(-1)).toBe('static');
    expect(r.canvas.gl?.count('createProgram')).toBe(0);
  });

  test('a CSS entry pauses its animation offscreen or in a hidden tab', async () => {
    const r = await rig({ css: true, wants: 'css', speed: 1, roles: ['accent'], pauseCss: true });
    expect(r.labels.at(-1)).toBe('css');
    r.host.setVisible(false);
    expect(r.root.getAttribute('data-effect-paused')).toBe('');
    r.host.setVisible(true);
    expect(r.root.getAttribute('data-effect-paused')).toBeNull();
  });

  test('the answer releases everything: loop, observers, listeners, context', async () => {
    const r = await rig({ ...SHADER, pauseCss: true });
    r.stop();
    expect(r.host.live()).toBe(0);
    expect(r.canvas.listening()).toBe(0);
    expect(r.canvas.gl?.count('loseContext')).toBe(1);
  });

  test('unmounted before the program arrives: nothing is compiled afterwards', async () => {
    const root = new FakeRoot();
    const canvas = new FakeCanvas();
    const host = new FakeHost();
    const stop = mountEffect(asElement(root), asCanvas(canvas), SHADER, host, () => {});
    stop();
    await Bun.sleep(0);
    expect(canvas.gl?.count('createProgram')).toBe(0);
    expect(host.live()).toBe(0);
  });
});
