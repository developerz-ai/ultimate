// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { unreplacedFocusRings } from './focus-visible';

const sheet = (scss: string) => [{ path: 'apps/web/app/post/ui.module.scss', scss }];

unitTest('outline: none with nothing in its place is refused', () => {
  const findings = unreplacedFocusRings(sheet('.trigger {\n  outline: none;\n}\n'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_FOCUS_VISIBLE');
  expect(findings[0]?.cause).toContain(':2');
  expect(findings[0]?.fix).toContain('focus-ring');
});

unitTest('outline: 0 is the same removal spelled differently', () => {
  expect(unreplacedFocusRings(sheet('.trigger { outline: 0; }'))).toHaveLength(1);
  expect(unreplacedFocusRings(sheet('.trigger { outline-style: none; }'))).toHaveLength(1);
});

unitTest('a nested :focus-visible that paints one back satisfies it', () => {
  const scss =
    '.trigger {\n  outline: none;\n  &:focus-visible { box-shadow: 0 0 0 2px tokens.role("accent"); }\n}';
  expect(unreplacedFocusRings(sheet(scss))).toEqual([]);
});

unitTest('a sibling :focus-visible rule beside it counts too', () => {
  const scss =
    '.trigger { outline: none; }\n.trigger:focus-visible { outline: 2px solid tokens.role("accent"); }';
  expect(unreplacedFocusRings(sheet(scss))).toEqual([]);
});

// The idiom this rule must never report: removing the ring for a MOUSE press and leaving the
// keyboard one alone is the correct thing to write, and reporting it teaches an author to delete
// the guard.
unitTest(':focus:not(:focus-visible) is the correct removal, not the defect', () => {
  expect(
    unreplacedFocusRings(sheet('.trigger:focus:not(:focus-visible) { outline: none; }')),
  ).toEqual([]);
});

unitTest('a focus mixin emits the rule no text scan can read into', () => {
  const scss = '.trigger {\n  @include tokens.focus-ring;\n  outline: none;\n}';
  expect(unreplacedFocusRings(sheet(scss))).toEqual([]);
});

unitTest('outline-offset moves the ring and does not remove it', () => {
  expect(unreplacedFocusRings(sheet('.trigger { outline-offset: 0; }'))).toEqual([]);
});

unitTest('a commented-out removal is a note, not a declaration', () => {
  expect(unreplacedFocusRings(sheet('// outline: none;\n.trigger { padding: 0; }'))).toEqual([]);
});
