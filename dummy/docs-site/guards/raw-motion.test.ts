// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawMotion } from './raw-motion';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawMotion(sheet(scss)).map((finding) => finding.fix);

unitTest('a duration literal is refused, and the fix is the declaration to write', () => {
  const findings = rawMotion(sheet('.a {\n  transition: opacity 120ms ease;\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_MOTION');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.fix).toStartWith('transition: opacity tokens.duration(fast) ease — ');
});

unitTest('seconds are read as milliseconds, and a time off the scale gets the nearest step', () => {
  expect(fixes('.a { animation-duration: 0.4s; }')[0]).toStartWith(
    'animation-duration: tokens.duration(slow) — ',
  );
  expect(fixes('.a { transition-duration: 300ms; }')[0]).toStartWith(
    'transition-duration: tokens.duration(base) — ',
  );
  expect(fixes('.a { animation: spin 2.4s linear infinite; }')[0]).toStartWith(
    'animation: spin tokens.duration(slower) linear infinite — ',
  );
});

unitTest('a cubic-bezier is refused, and one that IS a token is named', () => {
  expect(
    fixes('.a { transition: opacity tokens.duration(fast) cubic-bezier(0.16, 1, 0.3, 1); }')[0],
  ).toStartWith('transition: opacity tokens.duration(fast) tokens.easing(out) — ');
  expect(
    rawMotion(sheet('.a { animation-timing-function: cubic-bezier(0.2, 0, 0, 1); }')),
  ).toHaveLength(1);
});

unitTest('one declaration is one finding, with every literal in it rewritten', () => {
  const findings = rawMotion(
    sheet('.a { transition: color 220ms cubic-bezier(0.65, 0, 0.35, 1), opacity 640ms ease; }'),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toStartWith(
    'transition: color tokens.duration(base) tokens.easing(in-out), opacity tokens.duration(slower) ease — ',
  );
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../shared/tokens' as t;\n.a { transition-duration: 120ms; }";
  expect(fixes(scss)[0]).toStartWith('transition-duration: t.duration(fast) — ');
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a token, a keyword, a zero and a multiple of a token are silent', () => {
  const silent = [
    '.a { transition: opacity tokens.duration(fast) tokens.easing(out); }',
    '.a { transition: opacity var(--duration-fast) var(--easing-out); }',
    '.a { animation: spin calc(#{tokens.duration(slower)} * 2) linear infinite; }',
    '.a { transition: none; }',
    '.a { transition-delay: 0s; animation-delay: 0ms; }',
    '.a { animation-iteration-count: 3; }',
    '// transition: opacity 120ms;\n.a { transition: none; }',
    '.a { width: 100ms; }',
    '$tempo: 120ms;',
  ];
  for (const scss of silent) expect(rawMotion(sheet(scss))).toEqual([]);
});
