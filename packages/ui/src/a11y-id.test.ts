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
   * `for` / `aria-describedby` resolved to whichever came first. Two module instances are two
   * islands; a fresh query string is how one test process gets a second instance.
   */
  test('two island copies of this module never mint the same id in one document', async () => {
    const dom = installFakeDom(new FakeElement('div'));
    try {
      const island = (name: string): Promise<typeof import('./a11y')> =>
        import(`./a11y?island=${name}`);
      const one = await island('one');
      const two = await island('two');
      const ids = [one.useId('field'), two.useId('field'), one.useId('field'), two.useId('field')];
      expect(new Set(ids).size).toBe(4);
      expect(ids.every((id) => id.startsWith('field-'))).toBe(true);
    } finally {
      dom.restore();
    }
  });
});
