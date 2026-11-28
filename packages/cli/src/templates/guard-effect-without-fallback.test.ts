// The `effect-without-fallback` guard as `x new` emits it, run through the gate's own seam: a raw
// canvas, WebGL context or `navigator.gpu` in a `.tsx` is refused at its line; EffectCanvas and a
// 2d context are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardReport } from './shipped-guard-fixture';

const FILE = 'apps/web/app/feed/orb.island.tsx';

describe('unit · shipped guard · effect-without-fallback', () => {
  test('a raw canvas, WebGL context and navigator.gpu are X_EFFECT_WITHOUT_FALLBACK, report-only', async () => {
    const report = await shippedGuardReport('effect-without-fallback', {
      [FILE]: [
        'export const V = () => <canvas ref={r} />;',
        "const gl = r.getContext('webgl2');",
        'const gpu = navigator.gpu;',
        '',
      ].join('\n'),
    });
    expect(report.findings).toEqual([]);
    expect(report.warnings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_EFFECT_WITHOUT_FALLBACK', `${FILE}:1`],
      ['X_EFFECT_WITHOUT_FALLBACK', `${FILE}:2`],
      ['X_EFFECT_WITHOUT_FALLBACK', `${FILE}:3`],
    ]);
    expect(report.warnings[0]?.fix).toContain("EffectCanvas } from '@ultimat3/effects'");
  });

  test('EffectCanvas, a 2d context, a comment, a .ts file are silent; a file named effect-canvas.tsx is not exempt', async () => {
    const report = await shippedGuardReport('effect-without-fallback', {
      [FILE]:
        "// <canvas />\nexport const V = () => <EffectCanvas draw={d} fallback={<img />} />;\nconst c = r.getContext('2d');\n",
      'apps/web/shared/gpu.ts': 'export const has = navigator.gpu;\n',
    });
    expect([...report.findings, ...report.warnings]).toEqual([]);
    const named = await shippedGuardReport('effect-without-fallback', {
      'apps/web/shared/effect-canvas.tsx': 'export const C = () => <canvas />;\n',
    });
    expect(named.warnings).toHaveLength(1);
  });

  test('a comment-like string hides nothing: the canvas after it is still refused', async () => {
    const report = await shippedGuardReport('effect-without-fallback', {
      [FILE]: "const u = '//cdn'; export const V = () => <canvas />;\n",
    });
    expect(report.warnings).toHaveLength(1);
  });
});
