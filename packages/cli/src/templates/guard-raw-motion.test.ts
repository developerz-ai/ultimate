// The `raw-motion` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SHEET = 'apps/web/site/page.module.scss';

describe('unit · shipped guard · raw-motion', () => {
  test('a duration and a curve literal are X_RAW_MOTION, with the declaration to write', async () => {
    const findings = await shippedGuardFindings('raw-motion', {
      [SHEET]: '.a {\n  transition: opacity 120ms cubic-bezier(0.16, 1, 0.3, 1);\n}\n',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RAW_MOTION']);
    expect(findings[0]?.at).toBe(`${SHEET}:2`);
    expect(findings[0]?.fix).toStartWith(
      'transition: opacity tokens.duration(fast) tokens.easing(out) — ',
    );
  });

  test('the motion scale, a keyword and a multiple of a token are silent', async () => {
    const scss = [
      '.a { transition: opacity tokens.duration(fast) tokens.easing(out); }',
      '.b { animation: spin calc(#{tokens.duration(slower)} * 2) linear infinite; }',
      '',
    ].join('\n');
    expect(await shippedGuardFindings('raw-motion', { [SHEET]: scss })).toEqual([]);
  });
});
