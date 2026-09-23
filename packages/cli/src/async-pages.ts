// A route whose `Page` is an `async` function and which declares no `load`. It renders — the
// renderer awaits whatever the component returns — so no suite fails on it, and its data read
// silently skips everything `load` is for: the route's cache, `meta` computed from the data, the
// streaming boundary and the measurement render `x build` weighs. The social demo shipped eleven
// (plan 101 slice 11 l); nothing asked.

import type { RouteEntry } from '@ultimat3/render';
import { routeEntries } from '@ultimat3/render';
import type { Finding } from './output';

/** `async function Page` and `async () =>` both construct one; a sync one never does. */
const isAsync = (value: unknown): boolean =>
  typeof value === 'function' && value.constructor.name === 'AsyncFunction';

export function asyncPageFinding(file: string): Finding {
  return {
    code: 'X_ROUTE_ASYNC_PAGE',
    cause: `${file} exports an async Page, so its data read bypasses load's caching and meta`,
    fix: `in ${file}: move each await in Page into export const load = (ctx) => …, and read it with the page's data prop`,
    at: file,
  };
}

/** Every registered route whose page component is async and whose config declares no `load`. */
export function asyncPageFindings(
  entries: readonly Pick<RouteEntry, 'file' | 'config' | 'component'>[] = routeEntries(),
): readonly Finding[] {
  return entries
    .filter((entry) => entry.config.load === undefined && isAsync(entry.component))
    .map((entry) => asyncPageFinding(entry.file))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}
