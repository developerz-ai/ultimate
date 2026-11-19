// The three signals an engine gives for "this key is the IME's", and an ordinary key.

import { expect, test } from 'bun:test';
import { isComposingKey } from './composing-key';

test('isComposing, the Process key and the legacy 229 each mean a composition; a plain key does not', () => {
  expect(isComposingKey({ key: 'Enter', isComposing: true })).toBe(true);
  expect(isComposingKey({ key: 'Process' })).toBe(true);
  expect(isComposingKey({ key: 'Enter', keyCode: 229 })).toBe(true);
  expect(isComposingKey({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false);
  expect(isComposingKey({ key: 'ArrowDown' })).toBe(false);
});
