// The `untranslated-string` guard as `x new` emits it, run through the gate's own seam: typed prose
// is refused wherever an app renders it, `apps/*/shared` included.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const PROSE = 'export const A = () => <p>Hello there</p>;\n';

describe('unit · shipped guard · untranslated-string', () => {
  test('typed prose is refused in site/, app/, shared/ and a package', async () => {
    const findings = await shippedGuardFindings('untranslated-string', {
      'apps/web/site/a.tsx': PROSE,
      'apps/web/app/b.tsx': PROSE,
      'apps/web/shared/c.tsx': PROSE,
      'packages/ui/src/d.tsx': PROSE,
      'apps/web/shared/c.test.tsx': PROSE,
    });
    expect(findings.map((finding) => finding.at?.split(':')[0]).sort()).toEqual([
      'apps/web/app/b.tsx',
      'apps/web/shared/c.tsx',
      'apps/web/site/a.tsx',
      'packages/ui/src/d.tsx',
    ]);
  });
});
