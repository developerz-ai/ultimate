// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawBreakpoints } from './raw-breakpoint';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawBreakpoints(sheet(scss)).map((finding) => finding.fix);

unitTest('a hand-written min-width is refused, and the fix is the include to write', () => {
  const findings = rawBreakpoints(
    sheet('.a {\n  @media (min-width: 768px) {\n    gap: 0;\n  }\n}\n'),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_BREAKPOINT');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.fix).toStartWith('@include tokens.respond-to(md) — ');
});

unitTest('a max-width just under a rung is respond-down of that rung', () => {
  expect(fixes('@media (max-width: 767px) { .a { gap: 0; } }')[0]).toStartWith(
    '@include tokens.respond-down(md) — ',
  );
  expect(fixes('@media (max-width: 767.98px) { .a { gap: 0; } }')[0]).toStartWith(
    '@include tokens.respond-down(md) — ',
  );
});

unitTest(
  'both bounds are respond-between, and a width off the ladder gets the nearest rung',
  () => {
    const both = '@media screen and (min-width: 48em) and (max-width: 1023px) { .a { gap: 0; } }';
    expect(fixes(both)[0]).toStartWith('@include tokens.respond-between(md, lg) — ');
    expect(fixes('@media (min-width: 800px) { .a { gap: 0; } }')[0]).toStartWith(
      '@include tokens.respond-to(md) — ',
    );
  },
);

unitTest('the range syntax is the same query, and names the three mixins', () => {
  const findings = rawBreakpoints(sheet('@media (width >= 768px) { .a { gap: 0; } }'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toContain('tokens.respond-between(<from>, <to>)');
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../shared/tokens' as t;\n@media (min-width: 1024px) { .a { gap: 0; } }";
  expect(fixes(scss)[0]).toStartWith('@include t.respond-to(lg) — ');
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a query that is not about the viewport width is not a breakpoint', () => {
  const silent = [
    '@media (prefers-reduced-motion: no-preference) { .a { gap: 0; } }',
    '@media (prefers-color-scheme: dark) { .a { gap: 0; } }',
    '@media print { .a { gap: 0; } }',
    '@media (hover: hover) and (min-height: 600px) { .a { gap: 0; } }',
    '@container card (min-width: 30rem) { .a { gap: 0; } }',
    '.a { @include tokens.respond-to(md) { gap: 0; } }',
    '// @media (min-width: 768px) {}\n.a { gap: 0; }',
  ];
  for (const scss of silent) expect(rawBreakpoints(sheet(scss))).toEqual([]);
});

unitTest('a local respond-* mixin shadows the framework one, and is refused', () => {
  const findings = rawBreakpoints(sheet('@mixin respond-down($bp) {\n  @content;\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('defines its own respond-down');
  expect(findings[0]?.fix).toStartWith(
    'delete @mixin respond-down from apps/web/site/page.module.scss:1',
  );
});
