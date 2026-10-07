// Single responsibility: `waitForServiceWorker()` — wait for the worker to control the page, and
// hand the page over when it cannot claim it. The FIRST page of a run registers its worker on
// `load`, so it is committed before the worker activates, and `clients.claim()` can miss it: `ready`
// resolves, no `controllerchange` ever fires, and waiting longer waits for nothing (#678).

import { finiteCount } from '@ultimat3/core';
import { E2eServiceWorkerAbsentError } from './e2e-errors';
import type { E2eBrowserPage } from './e2e-page';

/**
 * How long a page whose worker is ACTIVE waits to be claimed before it is reloaded. Activation
 * sets `registration.active` — which resolves `ready` — before the activate handler reaches its
 * `clients.claim()`, so the claim trails `ready` by the cache cleanup in between. A second is
 * that gap with room; past it, the reload is cheaper than any further wait.
 */
export const CLAIM_GRACE_MS = 1_000;

/** What the page answers. `unclaimed`: an active worker, and a document it does not control. */
export type ServiceWorkerState = 'controlled' | 'unclaimed' | 'absent';

/**
 * The in-page half: `ready`, then the claim — an EVENT, not a poll, so the harness keeps exactly
 * one retry loop. Bounded IN THE PAGE by `timeoutMs`: an unbounded wait is a hung test, and CI then
 * reports a runner timeout with no assertion anywhere in it.
 */
export const serviceWorkerExpression = (timeoutMs: number): string =>
  `(() => {
  const sw = navigator.serviceWorker;
  if (!sw) return JSON.stringify({ state: 'absent' });
  const claimed = new Promise((resolve) => {
    if (sw.controller) { resolve('controlled'); return; }
    sw.addEventListener('controllerchange', () => resolve('controlled'), { once: true });
  });
  const grace = () => new Promise((resolve) =>
    setTimeout(() => resolve(sw.controller ? 'controlled' : 'unclaimed'), ${String(CLAIM_GRACE_MS)}));
  const deadline = new Promise((resolve) => setTimeout(() => resolve('absent'), ${String(timeoutMs)}));
  return Promise.race([sw.ready.then(() => Promise.race([claimed, grace()])), deadline])
    .catch(() => 'absent')
    .then((state) => JSON.stringify({ state }));
})()`;

const stateOf = (raw: unknown): ServiceWorkerState | undefined => {
  const decoded = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const state =
    typeof decoded === 'object' && decoded !== null
      ? (decoded as Record<string, unknown>)['state']
      : undefined;
  return state === 'controlled' || state === 'unclaimed' || state === 'absent' ? state : undefined;
};

/**
 * The URL to reload, fragment dropped: a navigation to the same URL plus a `#fragment` is a
 * same-document navigation in Chromium, which scrolls and never replaces the uncontrolled
 * document — the one thing the handover reload is for.
 */
const withoutFragment = (href: string): string => {
  const url = new URL(href);
  url.hash = '';
  return url.href;
};

export interface ServiceWorkerWait {
  readonly page: E2eBrowserPage;
  /** The whole budget, both checks and the reload between them. Screened by the caller. */
  readonly timeoutMs: number;
  /** The per-navigation deadline the reload is handed. */
  readonly navigationTimeoutMs: number;
}

/**
 * Wait for control; an unclaimed page is reloaded ONCE — that navigation is answered by the active
 * worker, which is what control means — then asked again with what is left of the budget. A page
 * with no worker at all is refused without a reload: the same request would answer the same.
 */
export async function waitForServiceWorker(wait: ServiceWorkerWait): Promise<void> {
  const { page, timeoutMs } = wait;
  const began = performance.now();
  const first = stateOf(await page.evaluate(serviceWorkerExpression(timeoutMs)));
  if (first === 'controlled') return;
  if (first === 'unclaimed') {
    await page.goto(withoutFragment(page.url()), { timeout: wait.navigationTimeoutMs });
    const left = Math.max(CLAIM_GRACE_MS, Math.round(timeoutMs - (performance.now() - began)));
    const second = stateOf(await page.evaluate(serviceWorkerExpression(left)));
    if (second === 'controlled') return;
    throw new E2eServiceWorkerAbsentError({ url: page.url(), timeoutMs, reloaded: true });
  }
  throw new E2eServiceWorkerAbsentError({ url: page.url(), timeoutMs, reloaded: false });
}

/** A per-call budget, screened where it is read — it is interpolated into the in-page source. */
export const callBudget = (fallback: number, timeoutMs: number | undefined): number =>
  timeoutMs === undefined ? fallback : finiteCount('waitForServiceWorker', 'timeoutMs', timeoutMs);
