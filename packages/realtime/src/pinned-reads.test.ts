// A read pinned to its own URL (`query({ http: { path } })`) is fetched THERE from the page — by
// `useQuery` and by a channel's catch-up — never at the derived `/_x/query/<kebab>`, which the
// server does not serve for a pinned read. The ref carries only the name: the pin is the one the
// SERVER stamped into the document (`<meta name="ultimate-pins">`), so it cannot drift.

import { afterEach, describe, expect, test } from 'bun:test';
import { CLIENT_PINS_META, encodeClientPins } from '@ultimat3/core';
import { catchUpRead } from './channel-catch-up';
import { flush, pageHarness, resetPage } from './hooks-fixture';
import { useQuery } from './use-query';

const realFetch = globalThis.fetch;

function answering(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;
  return urls;
}

/** The document a server pinning these two reads renders. */
function stamped(): void {
  const content = encodeClientPins({
    actions: {},
    queries: { orderById: '/orders/:id', orgFeedRead: '/orgs/:orgId/feed' },
  });
  Reflect.set(globalThis, 'document', {
    querySelector: (selector: string) =>
      selector === `meta[name="${CLIENT_PINS_META}"]` ? { content } : null,
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, 'document');
  resetPage();
});

describe('a pinned read from the page', () => {
  test('useQuery by name fills the stamped pin from the input and searches by the rest', async () => {
    pageHarness();
    stamped();
    const urls = answering();
    useQuery({ name: 'orderById' }, { id: 'a/b', expand: 'lines' });
    await flush();
    expect(urls).toEqual(['/orders/a%2Fb?expand=lines']);
  });

  test('a read the server did not pin still reads the derived URL', async () => {
    pageHarness();
    stamped();
    const urls = answering();
    useQuery({ name: 'listOrders' }, { id: 'o1' });
    await flush();
    expect(urls).toEqual(['/_x/query/list-orders?id=o1']);
  });

  test("a channel's catch-up read goes to its query's stamped pin", async () => {
    stamped();
    const urls = answering();
    await catchUpRead('orgFeedRead', { orgId: 'o1' });
    expect(urls).toEqual(['/orgs/o1/feed']);
  });
});
