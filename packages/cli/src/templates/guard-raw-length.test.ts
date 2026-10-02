// The `raw-length` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SHEET = 'apps/web/site/page.module.scss';

describe('unit · shipped guard · raw-length', () => {
  test('a raw px in a module is X_RAW_LENGTH, with the line and the declaration to write', async () => {
    const findings = await shippedGuardFindings('raw-length', {
      [SHEET]: "@use '@ultimat3/ui/tokens' as tokens;\n.hero {\n  padding: 12px;\n}\n",
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RAW_LENGTH']);
    expect(findings[0]?.at).toBe(`${SHEET}:3`);
    expect(findings[0]?.fix).toStartWith('padding: tokens.space(3) — ');
  });

  test('a px in an inline style is the same finding, from the markup', async () => {
    const findings = await shippedGuardFindings('raw-length', {
      'apps/web/site/page.tsx': "export const Page = () => <div style={{ width: '90px' }} />;\n",
    });
    expect(findings.map((finding) => finding.at)).toEqual(['apps/web/site/page.tsx:1']);
  });

  test('a local rem() is refused: it shadows the one the tokens ship', async () => {
    const findings = await shippedGuardFindings('raw-length', {
      'apps/web/shared/tokens.scss': '@function rem($px) {\n  @return $px;\n}\n',
    });
    expect(findings[0]?.fix).toStartWith('delete @function rem from apps/web/shared/tokens.scss:1');
  });

  test('tokens, rem(), a hairline and a definition are silent', async () => {
    const scss = [
      "@use '@ultimat3/ui/tokens' as tokens;",
      '$gutter: 12px;',
      '.hero {',
      '  padding: tokens.space(3);',
      '  inline-size: tokens.rem(340px);',
      "  border: 1px solid tokens.role('line');",
      '}',
      '',
    ].join('\n');
    expect(await shippedGuardFindings('raw-length', { [SHEET]: scss })).toEqual([]);
  });
});
