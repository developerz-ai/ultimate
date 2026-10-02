// The `raw-shadow` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SHEET = 'apps/web/site/page.module.scss';

describe('unit · shipped guard · raw-shadow', () => {
  test('a hand-written box-shadow is X_RAW_SHADOW, with the declaration to write', async () => {
    const findings = await shippedGuardFindings('raw-shadow', {
      [SHEET]: '.card {\n  box-shadow: 0 4px 12px rgb(0 0 0 / 0.2);\n}\n',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RAW_SHADOW']);
    expect(findings[0]?.at).toBe(`${SHEET}:2`);
    expect(findings[0]?.fix).toStartWith("box-shadow: tokens.shadow('sm') — ");
  });

  test('the shadow scale and a hairline ring are silent', async () => {
    const scss =
      ".card { box-shadow: tokens.shadow('md'); }\n.ring { box-shadow: inset 0 0 0 1px tokens.role('line'); }\n";
    expect(await shippedGuardFindings('raw-shadow', { [SHEET]: scss })).toEqual([]);
  });
});
