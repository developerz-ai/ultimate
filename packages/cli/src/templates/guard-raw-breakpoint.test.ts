// The `raw-breakpoint` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SHEET = 'apps/web/site/page.module.scss';

describe('unit · shipped guard · raw-breakpoint', () => {
  test('a hand-written max-width is X_RAW_BREAKPOINT, with the include to write', async () => {
    const findings = await shippedGuardFindings('raw-breakpoint', {
      [SHEET]: '.nav {\n  @media (max-width: 767px) {\n    display: none;\n  }\n}\n',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RAW_BREAKPOINT']);
    expect(findings[0]?.at).toBe(`${SHEET}:2`);
    expect(findings[0]?.fix).toStartWith('@include tokens.respond-down(md) — ');
  });

  test('a local respond-* mixin is refused: it shadows the one the tokens ship', async () => {
    const findings = await shippedGuardFindings('raw-breakpoint', {
      'apps/web/shared/tokens.scss': '@mixin respond-between($a, $b) {\n  @content;\n}\n',
    });
    expect(findings[0]?.fix).toStartWith(
      'delete @mixin respond-between from apps/web/shared/tokens.scss:1',
    );
  });

  test('the three mixins and a query that is not about width are silent', async () => {
    const scss = [
      "@use '@ultimat3/ui/tokens' as tokens;",
      '.nav {',
      '  @include tokens.respond-down(md) {',
      '    display: none;',
      '  }',
      '  @media (prefers-reduced-motion: no-preference) {',
      '    opacity: 1;',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(await shippedGuardFindings('raw-breakpoint', { [SHEET]: scss })).toEqual([]);
  });
});
