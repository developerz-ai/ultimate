// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawColours } from './raw-colour';

const sheet = (scss: string) => [{ path: 'apps/web/site/page.module.scss', scss }];

unitTest('a hex literal in a declaration is refused', () => {
  const findings = rawColours(sheet('.hero {\n  color: #ff0000;\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_COLOUR');
  expect(findings[0]?.cause).toContain('#ff0000');
  expect(findings[0]?.cause).toContain(':2');
});

unitTest('rgb(), hsl() and a named colour are the same rule', () => {
  const channels = rawColours(sheet('.a { background: rgb(1 2 3); }'));
  expect(channels).toHaveLength(1);
  // The whole call, never the bare `rgb(` — a fix line telling an author to replace `rgb(` names
  // nothing they can find in the file.
  expect(channels[0]?.cause).toContain('rgb(1 2 3)');
  expect(rawColours(sheet('.a { background: hsl(1 2% 3%); }'))).toHaveLength(1);
  expect(rawColours(sheet('.a { border-color: white; }'))).toHaveLength(1);
});

// The legitimate lookalike, and the one this rule got wrong: a channel function OVER TOKENS is the
// token form. `tokens.role('bg')` compiles to `rgb(var(--color-bg) / 1)`, so reading `rgb(` as a
// raw colour reports the idiom the rule exists to require — and a rule that noisy gets deleted.
unitTest('a channel function over var(--…) references is the token form', () => {
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg) / 1); }'))).toEqual([]);
  expect(rawColours(sheet('.a { background-color: rgb(var(--color-bg-soft)); }'))).toEqual([]);
  expect(rawColours(sheet('.a { border: 1px solid rgb(var(--color-line)); }'))).toEqual([]);
  expect(rawColours(sheet('.a { outline-color: rgba(var(--color-accent), 0.5); }'))).toEqual([]);
  expect(rawColours(sheet('.a { color: color(display-p3 var(--r) var(--g) var(--b)); }'))).toEqual(
    [],
  );
});

// The other direction: one reference does not launder the literals beside it, or every raw colour
// gains a one-token disguise.
unitTest('a literal channel beside a reference is still refused', () => {
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg-r) 2 3); }'))).toHaveLength(1);
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg-x, #ff0000)); }'))).toHaveLength(1);
});

// A Sass `#{…}` interpolation is a value that carries braces, and the declaration scan has to read
// PAST it: `role($name, $alpha)` emits exactly this, so a value stopping at the `{` leaves the
// commonest token form of all undecided rather than accepted.
unitTest('an interpolated alpha is still the token form, and is read whole', () => {
  expect(rawColours(sheet('.a { color: rgb(var(--color-fg) / #{$alpha}); }'))).toEqual([]);
  expect(rawColours(sheet('.a { color: rgb(1 2 3 / #{$alpha}); }'))).toHaveLength(1);
});

unitTest('a token, a selector and a quoted filename are not colours', () => {
  expect(rawColours(sheet(".a { background: tokens.role('bg'); }"))).toEqual([]);
  expect(rawColours(sheet('#hero { padding: 0; }'))).toEqual([]);
  expect(rawColours(sheet(".a { background: url('red-hero.png'); }"))).toEqual([]);
});

unitTest('a commented-out colour is a note, not a declaration', () => {
  expect(rawColours(sheet('// color: #ff0000;\n.a { padding: 0; }'))).toEqual([]);
  expect(rawColours(sheet('/* color: #ff0000; */\n.a { padding: 0; }'))).toEqual([]);
});
