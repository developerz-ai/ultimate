// The `raw-motion-script` guard as `x new` emits it, run through the gate's own seam: a numeric
// duration or delay in `.animate(` and a `cubic-bezier(` string are refused at their line,
// report-only by the guard's own declaration; a token read and a test file are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardReport } from './shipped-guard-fixture';

const FILE = 'apps/web/app/feed/card.island.tsx';

describe('unit · shipped guard · raw-motion-script', () => {
  test('a numeric duration and delay and a cubic-bezier string are X_RAW_MOTION_SCRIPT warnings', async () => {
    const report = await shippedGuardReport('raw-motion-script', {
      [FILE]:
        "el.animate({ opacity: [0, 1] }, { duration: 300, delay: 90 });\nconst e = 'cubic-bezier(0.16, 1, 0.3, 1)';\n",
      'apps/web/app/feed/ok.island.tsx':
        'el.animate({ opacity: [0, 1] }, { duration: motionTiming("base").duration });\n',
      'apps/web/app/feed/card.test.tsx': 'el.animate(k, { duration: 300 });\n',
    });
    expect(report.findings).toEqual([]);
    expect(report.warnings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_RAW_MOTION_SCRIPT', `${FILE}:1`],
      ['X_RAW_MOTION_SCRIPT', `${FILE}:1`],
      ['X_RAW_MOTION_SCRIPT', `${FILE}:2`],
    ]);
    expect(report.warnings[1]?.fix).toStartWith("delay: motionTiming('fast').duration — ");
    expect(report.warnings[2]?.fix).toStartWith("easing: motionTiming('base', 'out').easing — ");
  });

  test('stylesheets stay raw-motion’s: a scss literal is not this guard’s finding', async () => {
    const report = await shippedGuardReport('raw-motion-script', {
      'apps/web/site/page.module.scss': '.a { transition: opacity 120ms; }\n',
    });
    expect([...report.findings, ...report.warnings]).toEqual([]);
  });

  test('a comment-like string hides nothing: the call after it is still read', async () => {
    const report = await shippedGuardReport('raw-motion-script', {
      [FILE]:
        "const g = 'dist/*'; el.animate(k, { duration: 300 }); /** doc */\nconst u = '//cdn'; el.animate(k, { delay: 90 });\n",
    });
    expect(report.warnings.map((finding) => finding.at)).toEqual([`${FILE}:1`, `${FILE}:2`]);
  });
});
