// `useId`: distinct ids in one document, whichever copy of this module minted them — the server's
// one process, or each island's own bundle.

import { beforeEach, describe, expect, test } from 'bun:test';
import { resetIdCounter, useId } from './a11y';
import { FakeElement, installFakeDom } from './fake-dom';

describe('useId', () => {
  beforeEach(resetIdCounter);

  test('is unique and prefixed for label wiring', () => {
    const a = useId('field');
    const b = useId('field');
    expect(a).not.toBe(b);
    expect(a.startsWith('field-')).toBe(true);
  });

  test('a server render mints the plain counter — no random part in a document', () => {
    expect(useId('field')).toBe('field-1');
    expect(useId('field')).toBe('field-2');
  });

  /**
   * Each island is its own bundle by default (`islands.sharedChunks` off), so each carries its own
   * copy of this module and its own counter from zero: two islands both minted `field-1`, and
   * `for` / `aria-describedby` resolved to whichever came first. A second copy is modelled by
   * `resetIdCounter`, which puts this one back exactly where a freshly evaluated copy starts —
   * counter at zero, no scope drawn. (Importing the module again under a query string would do it
   * too, but Bun then reports that copy's coverage for this file instead of this one's.)
   */
  test('two island copies of this module never mint the same id in one document', () => {
    const dom = installFakeDom(new FakeElement('div'));
    try {
      const first = [useId('field'), useId('field')];
      resetIdCounter();
      const second = [useId('field'), useId('field')];
      expect(new Set([...first, ...second]).size).toBe(4);
      // Same counter value, different copy: only the scope tells them apart.
      expect(first[0]?.split('-').at(-1)).toBe(second[0]?.split('-').at(-1));
      expect([...first, ...second].every((id) => /^field-[0-9a-z]+-[0-9a-z]+$/.test(id))).toBe(
        true,
      );
    } finally {
      dom.restore();
    }
  });

  test('a copy draws its scope ONCE — every id it mints in one document shares it', () => {
    const dom = installFakeDom(new FakeElement('div'));
    try {
      const scopes = new Set([useId('a'), useId('b'), useId('c')].map((id) => id.split('-')[1]));
      expect(scopes.size).toBe(1);
    } finally {
      dom.restore();
    }
  });
});
