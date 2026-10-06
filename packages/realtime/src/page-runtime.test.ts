// The page runtime, installed once per page whoever asks: the boot and the runtime chunk both may
// run on one page, and the island bootstrap may have seated a sync target on the page before it.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError, pageClient, rescope } from '@ultimat3/core/page';
import { resetPage } from './hooks-fixture';
import { installPageRuntime } from './page-runtime';
import { installedPage, pageRealtime, peekPageRealtime } from './page-store';

afterEach(() => {
  resetPage();
  rescope(null);
});

describe('installPageRuntime', () => {
  test('installs ONE store and its services; a second install is the same page', () => {
    const page = installPageRuntime();
    expect(installPageRuntime()).toBe(page);
    expect(installPageRuntime().store).toBe(page.store);
    // Core's sink: every HTTP answer's records land in the page's one store.
    expect(pageClient().store).toBe(page.store);
  });

  test('fills the page object an island made first, keeping what it seated', () => {
    const early = pageRealtime(); // `installRealtime` ran before the runtime
    early.sync = { url: 'ws://node.test/_x/sync', buildId: 'b1' };
    const page = installPageRuntime();
    expect(page === early).toBe(true);
    expect(page.sync).toEqual({ url: 'ws://node.test/_x/sync', buildId: 'b1' });
  });

  test('a principal change clears the store it installed', () => {
    const page = installPageRuntime();
    page.store.adopt('posts', { p1: { id: 'p1' } });
    rescope('someone-else');
    expect(page.store.peek('posts', 'p1')).toBeUndefined();
  });
});

describe('installedPage', () => {
  test('before the runtime: X_REALTIME_UNINSTALLED naming the hook, and no store made', () => {
    let caught: unknown;
    try {
      installedPage('useRecord');
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_REALTIME_UNINSTALLED');
    expect(isUltimateError(caught) && caught.cause).toContain('useRecord()');
    expect(peekPageRealtime()?.store).toBeUndefined();
  });
});
