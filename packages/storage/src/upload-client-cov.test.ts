// `defaultSignedPut` picks the transport by what the runtime has: XHR where a browser offers one
// (real upload progress), `fetch` everywhere else. Bun has no `XMLHttpRequest`, so the browser half
// installs a stand-in for the one call and restores only what it installed.

import { describe, expect, test } from 'bun:test';
import { defaultSignedPut, fetchSignedPut, xhrSignedPut } from './upload-client';

describe('defaultSignedPut', () => {
  test('with no XMLHttpRequest (a server, Bun) it is the fetch transport', () => {
    expect(typeof (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest).toBe('undefined');
    expect(defaultSignedPut()).toBe(fetchSignedPut);
  });

  test('where XMLHttpRequest exists (a browser) it is the XHR transport', () => {
    const globals = globalThis as { XMLHttpRequest?: unknown };
    const had = 'XMLHttpRequest' in globals;
    const original = globals.XMLHttpRequest;
    globals.XMLHttpRequest = class {};
    try {
      expect(defaultSignedPut()).toBe(xhrSignedPut);
    } finally {
      if (had) globals.XMLHttpRequest = original;
      else delete globals.XMLHttpRequest;
    }
  });
});
