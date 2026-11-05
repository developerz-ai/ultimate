// The pins a browser reaches a pinned action or query by NAME through — and no tag at all for an
// app that pins nothing, whose documents (static ones included) keep the bytes they always had.

import { describe, expect, test } from 'bun:test';
import { encodeClientPins } from '@ultimat3/core';
import { clientPinTags } from './client-pins-tag';
import { renderHead } from './head';

const PINS = {
  actions: { refundOrder: { path: '/orders/:id/refund', method: 'PUT' as const } },
  queries: { orderById: '/orders/:id' },
};

describe('clientPinTags', () => {
  test('nothing pinned is no tag', () => {
    expect(clientPinTags({ actions: {}, queries: {} })).toEqual([]);
  });

  test("stamps core's format under the one meta core's readers ask for, escaped", () => {
    const [tag] = clientPinTags(PINS);
    expect(tag?.attrs).toEqual({
      name: 'ultimate-pins',
      content: encodeClientPins(PINS) ?? expect.unreachable('a pin to stamp'),
    });
    expect(tag?.key).toBe('meta:ultimate-pins');
    const html = renderHead(clientPinTags(PINS));
    expect(html.startsWith('<meta name="ultimate-pins" content="{&quot;a&quot;:')).toBe(true);
  });
});
