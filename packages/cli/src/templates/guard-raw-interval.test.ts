// The `raw-interval` guard as `x new` emits it, run through the gate's own seam: a `setInterval(`
// in an island is refused at its line; a `// why:`, `visibleInterval` and a server file are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const ISLAND = 'apps/web/app/feed/ticker.island.tsx';

describe('unit · shipped guard · raw-interval', () => {
  test('a bare, a window. and a globalThis. setInterval are X_RAW_INTERVAL at their lines', async () => {
    const findings = await shippedGuardFindings('raw-interval', {
      [ISLAND]: [
        'export const mount = () => {',
        '  const a = setInterval(poll, 5000);',
        '  const b = window.setInterval(poll, 5000);',
        '  const c = globalThis.setInterval(poll, 5000);',
        '  return () => [a, b, c].forEach(clearInterval);',
        '};',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_RAW_INTERVAL', `${ISLAND}:2`],
      ['X_RAW_INTERVAL', `${ISLAND}:3`],
      ['X_RAW_INTERVAL', `${ISLAND}:4`],
    ]);
    expect(findings[0]?.fix).toContain("import { visibleInterval } from '@ultimat3/core/page'");
  });

  test('a why:, visibleInterval, a server file and a test are silent', async () => {
    const call = 'setInterval(poll, 5000);\n';
    const findings = await shippedGuardFindings('raw-interval', {
      [ISLAND]: [
        "import { visibleInterval } from '@ultimat3/core/page';",
        'visibleInterval(poll, 5000);',
        'setInterval(tick, 16); // why: an animation frame, not a read',
        '// why: a clock face, not a read',
        'setInterval(tick, 1000);',
        '',
      ].join('\n'),
      'apps/web/app/feed/worker.ts': call,
      'apps/web/app/feed/ticker.island.test.tsx': call,
    });
    expect(findings).toEqual([]);
  });
});
