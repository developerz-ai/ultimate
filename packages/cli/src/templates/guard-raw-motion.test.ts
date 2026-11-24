// The `raw-motion` guard as `x new` emits it, run through the gate's own seam.
// It refuses the mistake it names — with the file, the line and the replacement to write — and
// stays silent on the legitimate lookalike. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { defineTheme } from '@ultimat3/ui';
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

  test('a raw curve or duration held in a custom property is the same finding', async () => {
    const findings = await shippedGuardFindings('raw-motion', {
      [SHEET]: [
        ':root {',
        '  --my-ease: cubic-bezier(0, 0, 1, 1);',
        '  --my-wait: 300ms;',
        '  --ok-ease: #{tokens.easing(out)};',
        '  --ok-wait: var(--duration-fast);',
        '  --gap: 12px;',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => finding.at)).toEqual([`${SHEET}:2`, `${SHEET}:3`]);
    expect(findings[0]?.fix).toStartWith('--my-ease: #{tokens.easing(out)} — ');
    expect(findings[1]?.fix).toStartWith('--my-wait: #{tokens.duration(base)} — ');
  });

  test('re-declaring a property of the scale itself names the theme slot, never another rung', async () => {
    // `--duration-base: #{tokens.duration(base)}` is a property reading itself: the app's tempo
    // lives in `defineTheme({ motion })`, which every `tokens.duration(base)` then moves at.
    const findings = await shippedGuardFindings('raw-motion', {
      [SHEET]:
        ':root {\n  --duration-base: 180ms;\n  --easing-out: cubic-bezier(0.2, 0, 0, 1);\n}\n',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RAW_MOTION', 'X_RAW_MOTION']);
    expect(findings[0]?.fix).toStartWith(
      "defineTheme({ motion: { duration: { base: '180ms' } } }) in apps/web/shared/theme.ts",
    );
    expect(findings[1]?.fix).toStartWith(
      "defineTheme({ motion: { easing: { out: 'cubic-bezier(0.2, 0, 0, 1)' } } }) in apps/web/shared/theme.ts",
    );
  });

  test('a re-declared rung in valid CSS the theme spells differently gets a fix that boots', async () => {
    // `.5s` and a compact curve are valid CSS, but `defineTheme` takes `0.5s` and
    // `cubic-bezier(0, 0, 1, 1)`: a fix copied verbatim would fail at boot with X_UI_INVALID_VALUE.
    const findings = await shippedGuardFindings('raw-motion', {
      [SHEET]: ':root {\n  --duration-base: .5s;\n  --easing-out: cubic-bezier(0,0,1,1);\n}\n',
    });
    expect(findings[0]?.fix).toStartWith(
      "defineTheme({ motion: { duration: { base: '0.5s' } } }) in apps/web/shared/theme.ts",
    );
    expect(findings[1]?.fix).toStartWith(
      "defineTheme({ motion: { easing: { out: 'cubic-bezier(0, 0, 1, 1)' } } }) in apps/web/shared/theme.ts",
    );
    // Round trip: the value each fix names is one the theme validator accepts.
    for (const finding of findings) {
      const [, scale = '', rung = '', value = ''] =
        /defineTheme\(\{ motion: \{ (\w+): \{ '?([\w-]+)'?: '([^']+)' \} \} \}\)/.exec(
          finding.fix,
        ) ?? [];
      expect(() => defineTheme({ motion: { [scale]: { [rung]: value } } })).not.toThrow();
    }
  });

  test('a leading plus and a trailing !important keep the re-declared value in the fix', async () => {
    const findings = await shippedGuardFindings('raw-motion', {
      [SHEET]: [
        ':root {',
        '  --duration-base: +180ms;',
        '  --easing-out: cubic-bezier(+0.2, 0, 0, 1);',
        '  --duration-slow: 300ms !important;',
        '}',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => finding.fix.split(' in apps/')[0])).toEqual([
      "defineTheme({ motion: { duration: { base: '180ms' } } })",
      "defineTheme({ motion: { easing: { out: 'cubic-bezier(0.2, 0, 0, 1)' } } })",
      "defineTheme({ motion: { duration: { slow: '300ms' } } })",
    ]);
    // The theme's `:root` line carries no priority: the fix says what moving it gives up.
    expect(findings[2]?.fix).toContain('without !important');
    expect(findings[0]?.fix).not.toContain('!important');
    expect(() =>
      defineTheme({
        motion: {
          duration: { base: '180ms', slow: '300ms' },
          easing: { out: 'cubic-bezier(0.2, 0, 0, 1)' },
        },
      }),
    ).not.toThrow();
  });

  test('a re-declared rung the theme cannot hold says so instead of naming a call that fails', async () => {
    const findings = await shippedGuardFindings('raw-motion', {
      [SHEET]:
        ':root {\n  --easing-out: cubic-bezier(1.5, 0, 0, 1);\n  --duration-base: calc(100ms * 2);\n}\n',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_RAW_MOTION', 'X_RAW_MOTION']);
    for (const finding of findings) expect(finding.cause).toContain('which a theme cannot hold');
    // The call names the rung's shipped value — one that boots — never the value it refused.
    expect(findings[0]?.fix).toStartWith(
      "defineTheme({ motion: { easing: { out: 'cubic-bezier(0.16, 1, 0.3, 1)' } } }) in apps/web/shared/theme.ts",
    );
    expect(findings[1]?.fix).toStartWith(
      "defineTheme({ motion: { duration: { base: '220ms' } } }) in apps/web/shared/theme.ts",
    );
    expect(() =>
      defineTheme({
        motion: { duration: { base: '220ms' }, easing: { out: 'cubic-bezier(0.16, 1, 0.3, 1)' } },
      }),
    ).not.toThrow();
  });
});
