// The `raw-frame-loop` guard as `x new` emits it, run through the gate's own seam: a bare
// `requestAnimationFrame(` is refused at its line; a `// why:`, a method and a test are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardReport } from './shipped-guard-fixture';

const FILE = 'apps/web/app/feed/orb.island.tsx';

describe('unit · shipped guard · raw-frame-loop', () => {
  test('a bare requestAnimationFrame is X_RAW_FRAME_LOOP at its line, report-only, naming frameLoop', async () => {
    const report = await shippedGuardReport('raw-frame-loop', {
      [FILE]: 'const a = 1;\nwindow.requestAnimationFrame(tick);\n',
      'apps/web/shared/loop.ts': 'requestAnimationFrame(tick);\n',
    });
    expect(report.findings).toEqual([]);
    expect(report.warnings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_RAW_FRAME_LOOP', `${FILE}:2`],
      ['X_RAW_FRAME_LOOP', 'apps/web/shared/loop.ts:1'],
    ]);
    expect(report.warnings[0]?.fix).toContain("frameLoop } from '@ultimat3/ui/motion'");
  });

  test('a why:, another object, frameLoop and a test file are silent', async () => {
    const report = await shippedGuardReport('raw-frame-loop', {
      [FILE]: [
        'requestAnimationFrame(focus); // why: one frame, not a loop',
        '// why: one frame, not a loop',
        'requestAnimationFrame(focus);',
        'clock.requestAnimationFrame(tick);',
        'frameLoop(tick, { el });',
        '',
      ].join('\n'),
      'apps/web/app/feed/orb.test.tsx': 'requestAnimationFrame(tick);\n',
    });
    expect([...report.findings, ...report.warnings]).toEqual([]);
  });
});
