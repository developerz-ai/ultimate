// The run's browser and app, reachable from any copy of this module — and refused by name outside
// a run, rather than answered with `undefined` a test would then call a method on.
import { afterEach, describe, expect, test } from 'bun:test';
import type { E2eBrowser } from './cdp-browser';
import type { E2eApp } from './e2e-app';
import {
  e2eApp,
  e2eBaseUrl,
  e2eBrowser,
  publishE2eRun,
  republishE2eBrowser,
} from './e2e-browser-handle';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.e2e.run'));
});

const browserNamed = (name: string): E2eBrowser => ({ name }) as unknown as E2eBrowser;
const app = { base: 'http://localhost:4100' } as unknown as E2eApp;

describe('unit · the e2e run handle', () => {
  test('outside a run the browser and the app are refused by name, and the base url is absent', () => {
    expect(() => e2eBrowser()).toThrow('X_CDP_BROWSER_MISSING');
    expect(() => e2eApp()).toThrow('X_CDP_BROWSER_MISSING');
    expect(e2eBaseUrl()).toBeUndefined();
  });

  test('a published run answers its browser, its app and its origin', () => {
    const first = browserNamed('first');
    publishE2eRun({ browser: first, app });
    expect(e2eBrowser()).toBe(first);
    expect(e2eApp()).toBe(app);
    expect(e2eBaseUrl()).toBe('http://localhost:4100');
  });

  test('a relaunched browser replaces the old one and keeps the app', () => {
    publishE2eRun({ browser: browserNamed('old'), app });
    const fresh = browserNamed('fresh');
    republishE2eBrowser(fresh);
    expect(e2eBrowser()).toBe(fresh);
    expect(e2eApp()).toBe(app);
  });

  test('republishing with no run is a no-op, never a run conjured from nothing', () => {
    republishE2eBrowser(browserNamed('orphan'));
    expect(e2eBaseUrl()).toBeUndefined();
  });
});
