// `fillWire`: the one request shape of a pinned HTTP primitive — the URL with every `:param` filled,
// and the input without those keys. What `action.client()`, `query.client()` and the page's
// `useMutation` all send, so none of them can split the input a different way.

import { describe, expect, test } from 'bun:test';
import { fillWire } from './fill-wire';

describe('fillWire', () => {
  test('fills each :param, encoded, and drops those keys from the rest', () => {
    expect(fillWire('/orgs/:orgId/orders/:id', { orgId: 'o1', id: 'a/b', note: 'x' })).toEqual({
      ok: true,
      url: '/orgs/o1/orders/a%2Fb',
      rest: { note: 'x' },
    });
  });

  test('a static path is the whole input, untouched — the same reference', () => {
    const input = { id: 'o1' };
    const filled = fillWire('/orders', input);
    expect(filled).toEqual({ ok: true, url: '/orders', rest: input });
    expect(filled.ok && filled.rest).toBe(input);
  });

  test('a static path passes a non-object input through', () => {
    expect(fillWire('/ping', null)).toEqual({ ok: true, url: '/ping', rest: null });
  });

  test("an unfillable :param is the template's refusal, named", () => {
    const filled = fillWire('/orders/:id', { note: 'x' });
    expect(filled.ok).toBe(false);
    expect(!filled.ok && filled.missing).toBe('id');
    expect(!filled.ok && filled.reason.length > 0).toBe(true);
  });
});
