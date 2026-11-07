// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { undeclaredCustomProperties } from './undeclared-custom-property';

/** What the app's global stylesheet compiles to: the tokens, declared once. */
const GLOBAL = {
  path: 'apps/web/shared/global.scss',
  scss: "@use '@ultimat3/ui/global.scss';\n",
  css: ':root{--space-1:.25rem;--space-2:.5rem;--space-4:1rem;--color-bg:253 246 240;--z-dialog:400}',
};

const sheet = (scss: string, css: string) => ({
  path: 'apps/web/site/page.module.scss',
  scss,
  css,
});
const check = (scss: string, css: string, sources: readonly string[] = []) =>
  undeclaredCustomProperties([GLOBAL, sheet(scss, css)], sources);

unitTest('a step the scale does not have is refused where the token call is written', () => {
  const findings = check(
    "@use '@ultimat3/ui/tokens' as tokens;\n.hero {\n  padding: tokens.space(7);\n}\n",
    '.hero{padding:var(--space-7)}',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_UNDECLARED_CUSTOM_PROPERTY');
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:3');
  expect(findings[0]?.cause).toContain('nothing in this app declares --space-7');
  expect(findings[0]?.fix).toStartWith(
    '1 | 2 | 4 — the steps --space-* has; write one in place of `7` at ',
  );
});

unitTest('a property nobody declares is refused where it is written', () => {
  const findings = check('.a {\n  color: var(--brand-ink);\n}\n', '.a{color:var(--brand-ink)}');
  expect(findings).toHaveLength(1);
  expect(findings[0]?.at).toBe('apps/web/site/page.module.scss:2');
  expect(findings[0]?.fix).toStartWith('declare --brand-ink where it is set');
  expect(findings[0]?.fix).toContain('defineTheme()');
});

unitTest('one undeclared property read three times in a sheet is one finding', () => {
  const css = '.a{color:var(--nope)}.b{color:var(--nope)}.c{color:var(--nope)}';
  expect(check('.a { color: var(--nope); }', css)).toHaveLength(1);
});

// The legitimate lookalikes — the reason the rule can stay switched on.
unitTest('a token the global sheet declares is silent, however it is read', () => {
  expect(check('.a { padding: tokens.space(4); }', '.a{padding:var(--space-4)}')).toEqual([]);
  expect(check('.a { color: tokens.role(bg); }', '.a{color:rgb(var(--color-bg)/1)}')).toEqual([]);
});

unitTest('a property the same or another module sets is declared', () => {
  const css = '.tone{--tone:rgb(var(--color-bg)/1)}.a{color:var(--tone)}';
  expect(check('.tone { --tone: x; } .a { color: var(--tone); }', css)).toEqual([]);
});

unitTest('a property an inline style can set is declared', () => {
  const tsx = "<div style={{ '--fill': percent }} />";
  expect(check('.bar { width: var(--fill); }', '.bar{width:var(--fill)}', [tsx])).toEqual([]);
});

unitTest('a read with a fallback declares its own answer', () => {
  expect(check('.a { color: var(--maybe, inherit); }', '.a{color:var(--maybe, inherit)}')).toEqual(
    [],
  );
});
