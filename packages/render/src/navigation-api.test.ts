// Navigating from code: through the router when the page has one, the browser's own load when it
// does not, nothing on the server — and `openModal` refuses, by code, a path no hash can address.
import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { NavigateOptions, NavigationRouter } from './navigation';
import { closeModal, navigate, openModal, refresh } from './navigation-api';

const globals = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete globals['window'];
});

/** A page at `/runs`, with a router that records every call, or none. */
function install(withRouter: boolean) {
  const calls: string[] = [];
  const location = {
    href: 'https://app.test/runs',
    assign: (url: string) => calls.push(`assign ${url}`),
    replace: (url: string) => calls.push(`replace ${url}`),
    reload: () => calls.push('reload'),
  };
  const router: NavigationRouter = {
    navigate: async (url: string, options?: NavigateOptions) => {
      calls.push(`navigate ${url} ${options?.history ?? 'push'}`);
    },
    prefetch: () => undefined,
    refresh: async () => {
      calls.push('refresh');
    },
    openModal: async (path: string) => {
      calls.push(`openModal ${path}`);
    },
    closeModal: () => calls.push('closeModal'),
    stop: () => undefined,
  };
  globals['window'] = withRouter ? { location, __xNavigation: router } : { location };
  return calls;
}

describe('with the router', () => {
  test('every call goes through it', async () => {
    const calls = install(true);
    await navigate('/runs/1');
    await navigate('/runs/2', { replace: true });
    await refresh();
    await openModal('/runs/new?bank=ve');
    closeModal();
    expect(calls).toEqual([
      'navigate https://app.test/runs/1 push',
      'navigate https://app.test/runs/2 replace',
      'refresh',
      'openModal /runs/new?bank=ve',
      'closeModal',
    ]);
  });

  test('another origin is a document load, never a router fetch', async () => {
    const calls = install(true);
    await navigate('https://pay.example/checkout');
    expect(calls).toEqual(['assign https://pay.example/checkout']);
  });
});

describe('without the router', () => {
  test("the browser's own load, reload, and the modal's whole page", async () => {
    const calls = install(false);
    await navigate('/runs/1');
    await navigate('/runs/2', { replace: true });
    await refresh();
    await openModal('/runs/new');
    closeModal();
    expect(calls).toEqual([
      'assign https://app.test/runs/1',
      'replace https://app.test/runs/2',
      'reload',
      'assign https://app.test/runs/new',
    ]);
  });

  test('on the server, nothing to navigate: no throw', async () => {
    await navigate('/runs');
    await refresh();
    closeModal();
    await openModal('/runs/new');
  });
});

test.each([['runs/new'], ['//evil.test/x'], ['https://app.test/runs/new'], ['/\\evil.test']])(
  'openModal(%p) is refused by code — a rejection, never a synchronous throw',
  async (path) => {
    install(true);
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = openModal(path);
    }).not.toThrow();
    const refused = await (pending ?? Promise.resolve()).then(
      () => expect.unreachable(`openModal(${path}) was accepted`),
      (error: unknown) => error,
    );
    if (!isUltimateError(refused)) return expect.unreachable('a coded refusal');
    expect(refused.code).toBe('X_NAVIGATION_MODAL_PATH_INVALID');
  },
);
