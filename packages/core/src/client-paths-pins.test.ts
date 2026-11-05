// The pins a server stamps into its document, and the browser's read of them: one format, written
// by `encodeClientPins` (the server's render) and read by `renderedActionPin`/`renderedQueryPin`.

import { afterEach, describe, expect, test } from 'bun:test';
import { encodeClientPins, renderedActionPin, renderedQueryPin } from './client-paths-pins';
import { CLIENT_PINS_META } from './page-meta';

const stamp = (content: unknown): void => {
  Reflect.set(globalThis, 'document', {
    querySelector: (selector: string) =>
      selector === `meta[name="${CLIENT_PINS_META}"]` && content !== undefined ? { content } : null,
  });
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

const PINS = {
  actions: { refundOrder: { path: '/orders/:id/refund', method: 'PUT' as const } },
  queries: { orderById: '/orders/:id' },
};

describe('encodeClientPins', () => {
  test('nothing pinned is no stamp at all', () => {
    expect(encodeClientPins({ actions: {}, queries: {} })).toBeUndefined();
  });

  test('is deterministic whatever order the registry handed the names in', () => {
    const a = encodeClientPins({
      actions: { b: PINS.actions.refundOrder, a: PINS.actions.refundOrder },
      queries: {},
    });
    const b = encodeClientPins({
      actions: { a: PINS.actions.refundOrder, b: PINS.actions.refundOrder },
      queries: {},
    });
    expect(a).toBe(b);
  });
});

describe('the pins a browser reads off the document', () => {
  test('round-trip: what the server wrote is what a caller resolves', () => {
    stamp(encodeClientPins(PINS));
    expect(renderedActionPin('refundOrder')).toEqual({ path: '/orders/:id/refund', method: 'PUT' });
    expect(renderedQueryPin('orderById')).toBe('/orders/:id');
  });

  test('an unpinned name is no pin', () => {
    stamp(encodeClientPins(PINS));
    expect(renderedActionPin('likePost')).toBeUndefined();
    expect(renderedQueryPin('refundOrder')).toBeUndefined();
    // Inherited members are not names a server pinned.
    expect(renderedQueryPin('constructor')).toBeUndefined();
  });

  test('no document, no stamp, or a stamp that is not the format: no pin, never a throw', () => {
    expect(renderedActionPin('refundOrder')).toBeUndefined();
    stamp(undefined);
    expect(renderedActionPin('refundOrder')).toBeUndefined();
    for (const content of ['{', '[]', '{"a":{"refundOrder":"GET /x"}}', '{"q":{"orderById":7}}']) {
      stamp(content);
      expect(renderedActionPin('refundOrder')).toBeUndefined();
      expect(renderedQueryPin('orderById')).toBeUndefined();
    }
  });
});
