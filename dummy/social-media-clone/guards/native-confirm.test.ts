// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { nativeConfirms, readsFile } from './native-confirm';

const file = (source: string) => [{ path: 'apps/web/app/posts/delete.island.tsx', source }];

unitTest('a bare confirm( is refused, and the finding names the line', () => {
  const findings = nativeConfirms(file("const a = 1;\nif (confirm('Delete?')) remove();"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_NATIVE_CONFIRM');
  expect(findings[0]?.at).toBe('apps/web/app/posts/delete.island.tsx:2');
});

unitTest('window., self. and globalThis. are the same rule', () => {
  expect(nativeConfirms(file("window.confirm('Delete?');"))).toHaveLength(1);
  expect(nativeConfirms(file("self.confirm('Delete?');"))).toHaveLength(1);
  expect(nativeConfirms(file("globalThis.confirm('Delete?');"))).toHaveLength(1);
});

unitTest('a why: on the line or the line above admits it', () => {
  expect(nativeConfirms(file("confirm('Leave?'); // why: an unload prompt"))).toEqual([]);
  expect(nativeConfirms(file("// why: a dev-only reset\nconfirm('Reset?');"))).toEqual([]);
});

unitTest('a comment, a string, a method and a definition are not calls', () => {
  expect(nativeConfirms(file("// confirm('Delete?');"))).toEqual([]);
  expect(nativeConfirms(file("const s = 'confirm(x)';"))).toEqual([]);
  expect(nativeConfirms(file('dialog.confirm(input);'))).toEqual([]);
  expect(nativeConfirms(file('function confirm(input) { return input; }'))).toEqual([]);
});

unitTest('islands and apps/web are read; tests and other packages are not', () => {
  expect(readsFile('apps/web/app/posts/page.tsx')).toBe(true);
  expect(readsFile('packages/ui/src/delete.island.tsx')).toBe(true);
  expect(readsFile('apps/web/app/posts/page.test.ts')).toBe(false);
  expect(readsFile('packages/domain/src/rules.ts')).toBe(false);
});
