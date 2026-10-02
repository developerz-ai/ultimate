// The `undeclared-custom-property` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SHEET = 'apps/web/site/page.module.scss';
const GLOBAL = 'apps/web/shared/global.scss';

describe('unit · shipped guard · undeclared-custom-property', () => {
  // Through the real token package: `tokens.space(7)` compiles, to a property nothing declares.
  test('a step the scale does not have is refused where the token call is written', async () => {
    const findings = await shippedGuardFindings(
      'undeclared-custom-property',
      {
        [GLOBAL]: "@use '@ultimat3/ui/global.scss';\n",
        [SHEET]: "@use '@ultimat3/ui/tokens' as tokens;\n.hero {\n  padding: tokens.space(7);\n}\n",
      },
      { ui: true },
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_UNDECLARED_CUSTOM_PROPERTY']);
    expect(findings[0]?.at).toBe(`${SHEET}:3`);
    expect(findings[0]?.fix).toStartWith('0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 — ');
  });

  test('a real step, a fallback and a property an inline style sets are silent', async () => {
    const scss = [
      "@use '@ultimat3/ui/tokens' as tokens;",
      '.hero {',
      '  padding: tokens.space(4);',
      '  color: var(--maybe, inherit);',
      '  inline-size: var(--fill);',
      '}',
      '',
    ].join('\n');
    const findings = await shippedGuardFindings(
      'undeclared-custom-property',
      {
        [GLOBAL]: "@use '@ultimat3/ui/global.scss';\n",
        [SHEET]: scss,
        'apps/web/site/page.tsx':
          "export const Page = () => <div style={{ '--fill': '40%' }} />;\n",
      },
      { ui: true },
    );
    expect(findings).toEqual([]);
  });

  // The declared set is only known when EVERY sheet compiled. With one broken, each read of a
  // property it declares would be reported — sixty findings about one Sass error the build names.
  test('a sheet that does not compile silences the rule rather than flooding it', async () => {
    const findings = await shippedGuardFindings('undeclared-custom-property', {
      [GLOBAL]: ':root { --brand-ink: ; \n',
      [SHEET]: '.a {\n  color: var(--brand-ink);\n}\n',
    });
    expect(findings).toEqual([]);
  });

  test('a property nothing declares is refused without the token package, too', async () => {
    const findings = await shippedGuardFindings('undeclared-custom-property', {
      [SHEET]: '.a {\n  color: var(--brand-ink);\n}\n',
    });
    expect(findings[0]?.at).toBe(`${SHEET}:2`);
    expect(findings[0]?.fix).toContain('defineTheme()');
  });
});
