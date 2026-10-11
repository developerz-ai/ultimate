// What the ISR suites split out of `render-isr.test.ts` share: one way to register an `isr` route
// with a given `revalidate`, and the key of a path in the suites' one locale.

import { registerRoute } from './registry';
import { isrKey } from './render-isr-key';
import type { RevalidateConfig, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

export function isrRouteWith(file: string, revalidate: RevalidateConfig): void {
  registerRoute({
    file,
    config: defineRoute({ render: 'isr', revalidate, offline: 'precache', hydrate: 'never', meta }),
  });
}

/** The store key for a path — `isrKey` owns the derivation. */
export const isrKeyIn = (path: string, locale = 'en'): string =>
  isrKey(new URL(`https://app.test${path}`), locale);
