// The one renderer action and query project a retirement through: both RFC spellings of one
// instant, a refusal as data rather than a throw, and the one counter both primitives feed.

import { afterEach, describe, expect, test } from 'bun:test';
import { recordDeprecatedCall, renderDeprecation } from './deprecation';
import { collectMetrics, resetMetrics } from './metrics';

afterEach(() => {
  resetMetrics();
});

const SINCE = '2026-08-01T00:00:00Z';
const SUNSET = '2026-12-31T23:59:59Z';

describe('renderDeprecation', () => {
  test('Deprecation is a structured-field Date, Sunset an IMF-fixdate', () => {
    const rendered = renderDeprecation({ since: SINCE, sunset: SUNSET }, undefined);
    expect(rendered).toEqual({
      ok: true,
      headers: { deprecation: '@1785542400', sunset: 'Thu, 31 Dec 2026 23:59:59 GMT' },
      meta: { since: '2026-08-01T00:00:00.000Z', sunset: '2026-12-31T23:59:59.000Z' },
    });
  });

  test('a successor path becomes the RFC 8288 link, and replacedBy rides the meta', () => {
    const rendered = renderDeprecation(
      { since: SINCE, sunset: SUNSET, replacedBy: 'searchOrders' },
      '/api/orders/search',
    );
    if (!rendered.ok) return expect.unreachable('a valid declaration renders');
    expect(rendered.headers['link']).toBe('</api/orders/search>; rel="successor-version"');
    expect(rendered.meta['replacedBy']).toBe('searchOrders');
  });

  test('an unparseable date is returned as data naming the field — never `Invalid Date`', () => {
    expect(renderDeprecation({ since: 'soon', sunset: SUNSET }, undefined)).toEqual({
      ok: false,
      field: 'since',
      value: 'soon',
    });
    expect(renderDeprecation({ since: SINCE, sunset: 'whenever' }, undefined)).toEqual({
      ok: false,
      field: 'sunset',
      value: 'whenever',
    });
  });
});

describe('recordDeprecatedCall', () => {
  test('one series per primitive and name, on the one deprecated_calls_total', () => {
    recordDeprecatedCall('action', 'listOrders');
    recordDeprecatedCall('action', 'listOrders');
    recordDeprecatedCall('query', 'listOrders');
    const metric = collectMetrics().metrics.find(
      (entry) => entry.descriptor.name === 'deprecated_calls_total',
    );
    expect(metric?.descriptor.kind).toBe('counter');
    expect(metric?.points).toEqual([
      { attributes: { primitive: 'action', name: 'listOrders' }, value: 2 },
      { attributes: { primitive: 'query', name: 'listOrders' }, value: 1 },
    ]);
  });
});
