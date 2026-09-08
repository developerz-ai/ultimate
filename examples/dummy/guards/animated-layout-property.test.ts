// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { animatedLayoutProperties } from './animated-layout-property';

const sheet = (scss: string) => [{ path: 'apps/web/app/post/ui.module.scss', scss }];

unitTest('transitioning a layout property is refused, and the fix names the equivalent', () => {
  const findings = animatedLayoutProperties(sheet('.panel {\n  transition: left 200ms ease;\n}'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_ANIMATED_LAYOUT_PROPERTY');
  expect(findings[0]?.cause).toContain(':2');
  expect(findings[0]?.fix).toContain('translateX');
});

unitTest('transition: all is refused outright', () => {
  const findings = animatedLayoutProperties(sheet('.panel { transition: all 200ms ease; }'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('every property');
});

// An omitted property IS `all` — the same defect, one word shorter, and the one an author does
// not read as a choice.
unitTest('a transition naming no property at all is the same rule', () => {
  const findings = animatedLayoutProperties(sheet('.panel { transition: 200ms ease; }'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('an omitted property');
});

unitTest('a layout property inside @keyframes is animated too', () => {
  const scss = '@keyframes slide {\n  from { margin-left: 0; }\n  to { margin-left: 40px; }\n}';
  const findings = animatedLayoutProperties(sheet(scss));
  expect(findings).toHaveLength(2);
  expect(findings[0]?.cause).toContain('@keyframes slide');
});

unitTest('transform and opacity are what this rule exists to leave alone', () => {
  const scss = '.panel { transition: transform tokens.duration("fast"), opacity 120ms linear; }';
  expect(animatedLayoutProperties(sheet(scss))).toEqual([]);
  const frames = '@keyframes fade { from { opacity: 0; } to { opacity: 1; transform: none; } }';
  expect(animatedLayoutProperties(sheet(frames))).toEqual([]);
});

// The one value that names no property and still animates nothing. Read as the implicit `all`
// above, it would report the declaration that turns the whole thing off.
unitTest('transition: none turns transitions off and is not one', () => {
  expect(animatedLayoutProperties(sheet('.panel { transition: none; }'))).toEqual([]);
});

unitTest('a plain layout declaration outside an animation is just layout', () => {
  expect(animatedLayoutProperties(sheet('.panel { margin-left: 40px; width: 100%; }'))).toEqual([]);
});

unitTest('a commented-out transition is a note, not a declaration', () => {
  expect(
    animatedLayoutProperties(sheet('// transition: all 200ms;\n.panel { padding: 0; }')),
  ).toEqual([]);
});
