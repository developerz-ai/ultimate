// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawShadows } from './raw-shadow';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];

unitTest('a hand-written box-shadow is refused, and the fix is the declaration to write', () => {
  const findings = rawShadows(sheet('.card {\n  box-shadow: 0 4px 12px rgb(0 0 0 / 0.2);\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_SHADOW');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.cause).toContain('4px');
  expect(findings[0]?.fix).toStartWith("box-shadow: tokens.shadow('sm') — ");
});

unitTest('text-shadow, a rem length and a drop-shadow filter are the same rule', () => {
  expect(rawShadows(sheet('.a { text-shadow: 0 0.25rem 0 currentcolor; }'))).toHaveLength(1);
  expect(rawShadows(sheet('.a { filter: drop-shadow(0 2px 4px currentcolor); }'))).toHaveLength(1);
});

unitTest('an inset line is repaired with the stroke scale, not the elevation scale', () => {
  const findings = rawShadows(sheet('.tab { box-shadow: inset 0 -2px 0 0 currentcolor; }'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toContain('tokens.stroke(thick)');
  expect(findings[0]?.fix).not.toContain('tokens.shadow(');
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../shared/tokens' as t;\n.a { box-shadow: 0 2px 6px black; }";
  expect(rawShadows(sheet(scss))[0]?.fix).toStartWith("box-shadow: t.shadow('sm') — ");
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a token, none, a hairline ring and a line drawn from tokens are silent', () => {
  const silent = [
    ".a { box-shadow: tokens.shadow('md'); }",
    '.a { box-shadow: var(--shadow-sm); }',
    '.a { box-shadow: none; }',
    ".a { box-shadow: inset 0 0 0 1px tokens.role('accent', 0.24); }",
    '.a { box-shadow: inset 0 calc(-1 * #{tokens.stroke(thick)}) 0 0 currentcolor; }',
    '.a { box-shadow: inset #{tokens.rem(-4.5px)} #{tokens.rem(-3px)} 0 0 currentcolor; }',
    ".a { box-shadow: tokens.shadow('sm'), inset 0 0 0 1px currentcolor; }",
    '// box-shadow: 0 4px 12px black;\n.a { box-shadow: none; }',
    '.a { padding: 4px 12px; }',
  ];
  for (const scss of silent) expect(rawShadows(sheet(scss))).toEqual([]);
});
