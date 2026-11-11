// The `image-dimensions` guard as `x new` emits it, run through the gate's own seam: an image with
// no box is refused wherever an app renders it, `apps/*/shared` included.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const IMG = 'export const A = () => <img src="/a.png" alt="" />;\n';

describe('unit · shipped guard · image-dimensions', () => {
  test('an unsized image is refused in site/, app/, shared/ and a package', async () => {
    const findings = await shippedGuardFindings('image-dimensions', {
      'apps/web/site/a.tsx': IMG,
      'apps/web/app/b.tsx': IMG,
      'apps/web/shared/c.tsx': IMG,
      'packages/ui/src/d.tsx': IMG,
      'apps/web/shared/c.test.tsx': IMG,
    });
    expect(findings.map((finding) => finding.at?.split(':')[0]).sort()).toEqual([
      'apps/web/app/b.tsx',
      'apps/web/shared/c.tsx',
      'apps/web/site/a.tsx',
      'packages/ui/src/d.tsx',
    ]);
  });
});
