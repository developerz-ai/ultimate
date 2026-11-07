// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawInlineLengths, rawLengths } from './raw-length';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];
const fixes = (scss: string) => rawLengths(sheet(scss)).map((finding) => finding.fix);

unitTest('a px on the space scale is refused, and the fix is the declaration to write', () => {
  const findings = rawLengths(sheet('.hero {\n  padding: 12px;\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_LENGTH');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.cause).toContain('padding: 12px');
  expect(findings[0]?.fix).toStartWith('padding: tokens.space(3) — ');
});

unitTest('a px off the scale is written through rem()', () => {
  expect(fixes('.a { font-size: 14px; }')[0]).toStartWith('font-size: tokens.rem(14px) — ');
});

unitTest('one statement is one finding, with every literal in it rewritten', () => {
  const findings = rawLengths(sheet('.a { margin: 8px 14px -16px; }'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toStartWith(
    'margin: tokens.space(2) tokens.rem(14px) calc(-1 * #{tokens.space(4)}) — ',
  );
});

unitTest('the fix speaks the namespace the sheet uses the tokens under', () => {
  const scss = "@use '../../shared/tokens' as t;\n.a { gap: 8px; }";
  expect(fixes(scss)[0]).toStartWith('gap: t.space(2) — ');
});

unitTest('a line weight is a stroke, not a space step', () => {
  expect(fixes('.a { border: 2px solid currentcolor; }')[0]).toStartWith(
    'border: tokens.stroke(thick) solid currentcolor — ',
  );
  expect(fixes('.a { outline-offset: -3px; }')[0]).toStartWith(
    'outline-offset: calc(-1 * #{tokens.stroke(heavy)}) — ',
  );
});

unitTest('an @include argument is a use', () => {
  expect(fixes('.a { @include tokens.focus-ring(accent, 4px); }')[0]).toStartWith(
    '@include tokens.focus-ring(accent, tokens.space(1)) — ',
  );
});

unitTest('a hairline and a zero are not lengths anyone scales', () => {
  expect(rawLengths(sheet('.a { border: 1px solid; margin: -1px; inset: 0px; }'))).toEqual([]);
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a px handed to rem() or fluid() is the sanctioned spelling', () => {
  expect(rawLengths(sheet('.a { width: tokens.rem(340px); }'))).toEqual([]);
  expect(rawLengths(sheet('.a { font-size: tokens.fluid(16px, 32px); }'))).toEqual([]);
  expect(rawLengths(sheet('.a { margin: calc(-1 * #{tokens.rem(6px)}) 0; }'))).toEqual([]);
});

unitTest('a definition names a value in one place, and is not a use', () => {
  expect(rawLengths(sheet('$gutter: 12px;\n$map: (\n  sm: 480px,\n  md: 768px,\n);\n'))).toEqual(
    [],
  );
  expect(rawLengths(sheet('@mixin ring($width: 2px) { outline-width: $width; }'))).toEqual([]);
});

unitTest('a named ARGUMENT is a use, however much it looks like a definition', () => {
  expect(rawLengths(sheet('.a { @include ring($width: 4px); }'))).toHaveLength(1);
});

unitTest('a comment, a quoted name and a class name are not lengths', () => {
  expect(rawLengths(sheet('// padding: 12px;\n/* gap: 12px */\n.a { padding: 0; }'))).toEqual([]);
  expect(rawLengths(sheet(".a { background: url('hero-640px.png'); }"))).toEqual([]);
  expect(rawLengths(sheet('.gap-12px { padding: 0; }'))).toEqual([]);
});

unitTest('a comment above a declaration is not part of the statement the finding quotes', () => {
  const findings = rawLengths(sheet('.a {\n  // why this is wide\n  padding: 12px;\n}\n'));
  expect(findings[0]?.cause).toContain('writes `padding: 12px`');
  expect(findings[0]?.fix).toStartWith('padding: tokens.space(3) — ');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:3');
});

unitTest('a viewport query and a shadow belong to their own guards', () => {
  expect(rawLengths(sheet('@media (min-width: 768px) { .a { padding: 0; } }'))).toEqual([]);
  expect(rawLengths(sheet('.a { box-shadow: 0 4px 12px black; }'))).toEqual([]);
});

unitTest('a value after an interpolation is still read as part of its declaration', () => {
  const findings = rawLengths(sheet('.a { margin: calc(-1 * #{tokens.space(4)}) 12px; }'));
  expect(findings[0]?.fix).toStartWith('margin: calc(-1 * #{tokens.space(4)}) tokens.space(3) — ');
});

unitTest('a local rem() or fluid() shadows the framework one, and is refused', () => {
  const findings = rawLengths(sheet('@function rem($value) {\n  @return $value;\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('defines its own rem()');
  expect(findings[0]?.fix).toStartWith(
    'delete @function rem from apps/web/site/page.module.scss:1',
  );
});

const markup = (tsx: string) => [{ path: 'apps/web/site/page.tsx', tsx }];

unitTest('a px in an inline style is the same mistake in markup', () => {
  const findings = rawInlineLengths(markup("<div style={{ padding: '12px', width: '90px' }} />"));
  expect(findings.map((finding) => finding.fix.split(' in place of ')[0])).toEqual([
    'var(--space-3)',
    '5.625rem',
  ]);
  expect(rawInlineLengths(markup('<div style="margin-top: 20px" />'))).toHaveLength(1);
});

unitTest('a custom property and a hairline in an inline style are silent', () => {
  expect(
    rawInlineLengths(markup("<div style={{ '--fill': '40%', border: '1px solid' }} />")),
  ).toEqual([]);
});
