// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawZIndexes } from './raw-z-index';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawZIndexes(sheet(scss)).map((finding) => finding.fix);

unitTest('a numeric z-index is refused, and the fix is the layer it means', () => {
  const findings = rawZIndexes(sheet('.menu {\n  z-index: 200;\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_Z_INDEX');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.fix).toStartWith('z-index: tokens.z(dropdown) — ');
});

unitTest('a number off the ladder gets the nearest layer', () => {
  expect(fixes('.a { z-index: 9999; }')[0]).toStartWith('z-index: tokens.z(skip-nav) — ');
  expect(fixes('.a { z-index: 1; }')[0]).toStartWith('z-index: tokens.z(raised) — ');
  expect(fixes('.a { z-index: 0; }')[0]).toStartWith('z-index: tokens.z(base) — ');
});

unitTest('a negative number is the negation of a layer, never of base', () => {
  expect(fixes('.a { z-index: -1; }')[0]).toStartWith('z-index: calc(-1 * #{tokens.z(raised)}) — ');
});

unitTest('a number beside a token is still a number', () => {
  expect(rawZIndexes(sheet('.a { z-index: calc(#{tokens.z(dialog)} + 1); }'))).toHaveLength(1);
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../shared/tokens' as t;\n.a { z-index: 400; }";
  expect(fixes(scss)[0]).toStartWith('z-index: t.z(dialog) — ');
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a token, its negation and a keyword are silent', () => {
  const silent = [
    '.a { z-index: tokens.z(dialog); }',
    ".a { z-index: tokens.z('skip-nav'); }",
    '.a { z-index: var(--z-toast); }',
    '.a { z-index: calc(-1 * #{tokens.z(raised)}); }',
    '.a { z-index: auto; }',
    '.a { z-index: inherit; }',
    '// z-index: 5;\n.a { z-index: auto; }',
    '$z-index: 5;',
  ];
  for (const scss of silent) expect(rawZIndexes(sheet(scss))).toEqual([]);
});
