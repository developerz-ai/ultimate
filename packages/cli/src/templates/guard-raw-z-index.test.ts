// The `raw-z-index` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SHEET = 'apps/web/site/page.module.scss';

describe('unit · shipped guard · raw-z-index', () => {
  test('a numeric z-index is X_RAW_Z_INDEX, with the layer to write', async () => {
    const findings = await shippedGuardFindings('raw-z-index', {
      [SHEET]: '.menu {\n  z-index: 200;\n}\n',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RAW_Z_INDEX']);
    expect(findings[0]?.at).toBe(`${SHEET}:2`);
    expect(findings[0]?.fix).toStartWith('z-index: tokens.z(dropdown) — ');
  });

  test('a named layer and the negation of one are silent', async () => {
    const scss =
      '.menu { z-index: tokens.z(dropdown); }\n.glow { z-index: calc(-1 * #{tokens.z(raised)}); }\n';
    expect(await shippedGuardFindings('raw-z-index', { [SHEET]: scss })).toEqual([]);
  });
});
