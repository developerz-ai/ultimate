// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { semanticInteractive } from './semantic-interactive';

const file = (source: string) => [{ path: 'apps/web/app/post/page.tsx', source }];

unitTest('a div with a click handler is refused, and the finding names the line', () => {
  const findings = semanticInteractive(
    file('<main>\n  <div onClick={() => save()}>Save</div>\n</main>'),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_SEMANTIC_INTERACTIVE');
  expect(findings[0]?.cause).toContain(':2');
  expect(findings[0]?.fix).toContain('<button type="button">');
});

unitTest('role="button" on a div names the native element to write instead', () => {
  const findings = semanticInteractive(file('<div role="button" onClick={go}>Go</div>'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain('a role is a promise');
  expect(findings[0]?.fix).toContain('<button type="button">');
});

unitTest('the native control it names is not itself a finding', () => {
  expect(semanticInteractive(file('<button type="button" onClick={go}>Go</button>'))).toEqual([]);
  expect(semanticInteractive(file('<a href="/x" onClick={go}>Go</a>'))).toEqual([]);
});

// The boundary, stated: a role, a tab stop and a key handler together are the complete set the
// ARIA practices guide asks for. This rule reports the INCOMPLETE widget, never the deliberate one.
unitTest('a role with a tab stop and a key handler is a deliberate widget', () => {
  const widget = '<div role="button" tabindex="0" onClick={go} onKeyDown={go}>Go</div>';
  expect(semanticInteractive(file(widget))).toEqual([]);
});

unitTest('data-role is not role, and a live region is not a control', () => {
  expect(semanticInteractive(file('<p data-role="status" role="status">Saved</p>'))).toEqual([]);
});

// The reason the tag end is scanned rather than matched: an arrow function's `>` closes nothing,
// and a pattern that stopped at it would read the element as ending before its own handler.
unitTest('an arrow function in an earlier attribute does not end the tag', () => {
  const source = '<div class={cx(() => a > b)} onClick={go}>Go</div>';
  expect(semanticInteractive(file(source))).toHaveLength(1);
});

unitTest('a commented-out handler is a note, not an element', () => {
  expect(semanticInteractive(file('// <div onClick={go}>Go</div>\nconst a = 1;'))).toEqual([]);
});
