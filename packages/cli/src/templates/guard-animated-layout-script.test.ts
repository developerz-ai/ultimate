// The `animated-layout-script` guard as `x new` emits it, run through the gate's own
// seam: a layout key handed to `.animate(` is refused at its line and the fix names `layout()`.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const FILE = 'apps/web/app/feed/card.island.tsx';

describe('unit · shipped guard · animated-layout-script', () => {
  test('width, marginLeft and "box-shadow" in .animate( are X_ANIMATED_LAYOUT_SCRIPT, naming layout()', async () => {
    const findings = await shippedGuardFindings('animated-layout-script', {
      [FILE]: [
        'el.animate({ width: ["0px", "9px"] }, { duration: t });',
        'el.animate({ marginLeft: 4, "box-shadow": s }, { duration: t });',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_ANIMATED_LAYOUT_SCRIPT', `${FILE}:1`],
      ['X_ANIMATED_LAYOUT_SCRIPT', `${FILE}:2`],
      ['X_ANIMATED_LAYOUT_SCRIPT', `${FILE}:2`],
    ]);
    expect(findings[0]?.fix).toContain("layout() — import { layout } from '@ultimat3/ui/motion'");
  });

  test('transform and opacity, another call, a comment and a test file are silent', async () => {
    const findings = await shippedGuardFindings('animated-layout-script', {
      [FILE]:
        '// el.animate({ width: 1 });\nel.animate({ transform: "none", opacity: [0, 1] }, { duration: t });\nplace({ width: 3 });\n',
      'apps/web/app/feed/card.test.tsx': 'el.animate({ width: 1 });\n',
    });
    expect(findings).toEqual([]);
  });
});
