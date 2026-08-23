// A fake that answers differently from the real DOM makes every suite built on it lie, so the
// fidelity of the fake is itself worth a test. This one pins the answer a real
// `Element.getAttribute` gives for a name that happens to be an `Object.prototype` member: `null`.

import { describe, expect, test } from 'bun:test';
import { FakeElement } from './fake-dom';

describe('unit · FakeElement.getAttribute reads own keys, never the prototype chain', () => {
  // `this.attrs` is a `{...spread}`, so `attrs['constructor']` answered with the `Object` FUNCTION
  // where the signature says `string | null`. A real `document.createElement('div')` answers
  // `null`. Consequence in the fake's own selector grammar: `attrMatches` decides presence with
  // `getAttribute(inner) !== null`, so `querySelectorAll('[constructor]')` matched EVERY element.
  test.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'an attribute named %s is absent, not a function off Object.prototype',
    (name) => {
      const element = new FakeElement('div');
      expect(element.getAttribute(name)).toBeNull();
    },
  );

  test('an attribute that was actually set still reads back', () => {
    const element = new FakeElement('a', { href: '/posts', tabindex: '0' });
    expect(element.getAttribute('href')).toBe('/posts');
    expect(element.getAttribute('tabindex')).toBe('0');
  });

  test('a selector naming an Object.prototype member matches nothing', () => {
    const root = new FakeElement('div').append(
      new FakeElement('button'),
      new FakeElement('a', { href: '/posts' }),
    );
    expect(root.querySelectorAll('[constructor]')).toHaveLength(0);
    expect(root.querySelectorAll('[href]')).toHaveLength(1);
  });
});
