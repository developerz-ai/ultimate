import { describe, expect, test } from 'bun:test';
import { asCanvas, FakeCanvas, FakeHost } from './fake-host-fixture';
import { mountShader, type ShaderProgram } from './shader-mount';

const PROGRAM: ShaderProgram = {
  vertex: 'vertex source',
  fragment: 'fragment source',
  uniforms: (frame) => ({
    u_time: ['1f', frame.time],
    u_point: ['2fv', new Float32Array([frame.width, frame.height])],
    u_tint: ['3fv', new Float32Array([1, 0, 0])],
    u_edge: ['4fv', new Float32Array([0, 0, 1, 1])],
  }),
};

const setup = (): { canvas: FakeCanvas; host: FakeHost; lost: string[] } => ({
  canvas: new FakeCanvas(),
  host: new FakeHost(),
  lost: [],
});

const mount = (s: ReturnType<typeof setup>, speed = 1) =>
  mountShader(asCanvas(s.canvas), PROGRAM, s.host, {
    speed,
    onLost: () => s.lost.push('lost'),
    onRestored: () => s.lost.push('restored'),
  });

const times = (canvas: FakeCanvas): unknown[] =>
  (canvas.gl?.calls ?? []).filter((c) => c[0] === 'uniform' && c[1] === 'u_time').map((c) => c[2]);

describe('unit · shader mount', () => {
  test('compiles both stages, links, and draws one triangle per frame', () => {
    const s = setup();
    const result = mount(s);
    expect(result.ok).toBe(true);
    expect(s.canvas.gl?.sources).toEqual(['vertex source', 'fragment source']);
    s.host.frame();
    s.host.frame();
    expect(s.canvas.gl?.count('drawArrays')).toBe(2);
    expect(s.canvas.gl?.calls.find((c) => c[0] === 'drawArrays')).toEqual([
      'drawArrays',
      0x0004,
      0,
      3,
    ]);
  });

  test('every uniform kind reaches the matching upload', () => {
    const s = setup();
    mount(s);
    s.host.frame();
    const sent = (s.canvas.gl?.calls ?? []).filter((c) => c[0] === 'uniform').map((c) => c[1]);
    expect(sent).toEqual(['u_time', 'u_point', 'u_tint', 'u_edge']);
  });

  test('the first frame drawn is frame 0: time 0, then seconds scaled by speed', () => {
    const s = setup();
    mount(s, 2);
    s.host.frame(16);
    s.host.frame(500);
    expect(times(s.canvas)).toEqual([0, 0.2]);
  });

  test('a long stall (a paused or hidden tab) advances at most one capped step', () => {
    const s = setup();
    mount(s);
    s.host.frame();
    s.host.frame(60_000);
    expect(times(s.canvas)[1]).toBeCloseTo(0.1, 5);
  });

  test('the backing store follows the box under the pixel budget', () => {
    const s = setup();
    s.host.ratio = 3;
    mount(s);
    s.host.frame();
    expect([s.canvas.width, s.canvas.height]).toEqual([800, 600]);
    s.host.resize(100, 50);
    s.host.frame();
    expect([s.canvas.width, s.canvas.height]).toEqual([200, 100]);
    expect(s.canvas.gl?.calls.filter((c) => c[0] === 'viewport').at(-1)).toEqual([
      'viewport',
      0,
      0,
      200,
      100,
    ]);
  });

  test('no WebGL2 context, a compile failure and a link failure each answer why, holding nothing', () => {
    const none = setup();
    none.canvas.gl = null;
    expect(mount(none)).toEqual({ ok: false, reason: 'no-context' });

    const compile = setup();
    if (compile.canvas.gl) compile.canvas.gl.compiles = false;
    expect(mount(compile)).toEqual({ ok: false, reason: 'compile' });
    expect(compile.host.live()).toBe(0);
    expect(compile.canvas.gl?.count('deleteShader')).toBeGreaterThan(0);

    const link = setup();
    if (link.canvas.gl) link.canvas.gl.links = false;
    expect(mount(link)).toEqual({ ok: false, reason: 'link' });
    expect(link.canvas.gl?.count('deleteProgram')).toBe(1);
    expect(link.canvas.listening()).toBe(0);
  });

  test('context loss stops drawing and asks the browser for it back; restore recompiles', () => {
    const s = setup();
    mount(s);
    s.host.frame();
    s.canvas.dispatch('webglcontextlost');
    expect(s.canvas.prevented).toBe(1);
    expect(s.lost).toEqual(['lost']);
    s.host.frame();
    expect(s.canvas.gl?.count('drawArrays')).toBe(1);

    s.canvas.dispatch('webglcontextrestored');
    expect(s.lost).toEqual(['lost', 'restored']);
    expect(s.canvas.gl?.count('createProgram')).toBe(2);
    s.host.frame();
    expect(s.canvas.gl?.count('drawArrays')).toBe(2);
  });

  test('dispose stops the loop, unhooks everything and releases the context', () => {
    const s = setup();
    const result = mount(s);
    if (!result.ok) return expect.unreachable('the fake context failed to mount');
    result.mount.dispose();
    expect(s.host.live()).toBe(0);
    expect(s.canvas.listening()).toBe(0);
    expect(s.canvas.gl?.count('deleteProgram')).toBe(1);
    expect(s.canvas.gl?.count('loseContext')).toBe(1);
    s.host.frame();
    expect(s.canvas.gl?.count('drawArrays')).toBe(0);
  });
});
