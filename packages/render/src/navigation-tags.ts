/**
 * What an opted-in document carries for the client router: its surface, its build (the skew check,
 * deduped with realtime's sync tags by key), the router's script, a modal route's presentation, and
 * the surface's modal routes so a click opens the dialog before the answer. Nothing elsewhere.
 */

import { CLIENT_BUILD_META, routeRank } from '@ultimat3/core';
import { byCodeUnit } from './code-unit-order';
import type { HeadTag } from './head';
import {
  type ModalRoutes,
  NAVIGATION_MODALS_META,
  NAVIGATION_PRESENTATION_META,
} from './navigation-modal-rules';
import { NAVIGATION_META } from './navigation-rules';

export interface ClientNavigationHead {
  /** The surface this document belongs to — a link that lands on another is a full load. */
  readonly surface: string;
  readonly buildId: string;
  /** `/_x/assets/navigation/<hash>.js`, content-addressed and served `immutable`. */
  readonly scriptUrl: string;
  /** The route declared `navigation: 'modal'`: the router shows it over the page beneath. */
  readonly modal?: boolean;
  /** The surface's modal routes (`modalRouteList`) and the frame's words, in the page's locale. */
  readonly modals?: ModalRoutes;
}

/** Whether some pathname matches both patterns — segment by segment, a catch-all takes the rest. */
function overlap(a: string, b: string): boolean {
  const left = a.split('/').filter((s) => s.length > 0);
  const right = b.split('/').filter((s) => s.length > 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l?.startsWith('*') === true || r?.startsWith('*') === true) return true;
    if (l === undefined || r === undefined) return false;
    if (!l.startsWith(':') && !r.startsWith(':') && l !== r) return false;
  }
  return true;
}

/**
 * The modals meta's `routes`: every modal pattern, plus — as `!<pattern>` — every page that is NOT
 * a modal yet matches a path a modal pattern matches and outranks it (`routeRank`, the request
 * router's own order: `/runs/new/peek` before `/runs/:id/peek`). Most specific first, so the
 * router's first match is the route the server will run. Deterministic: ties by code unit.
 */
export function modalRouteList(
  pages: readonly { readonly path: string; readonly modal: boolean }[],
): string[] {
  const modals = pages.filter((page) => page.modal).map((page) => page.path);
  const shadows = pages
    .filter((page) => !page.modal)
    .map((page) => page.path)
    .filter((path) => modals.some((m) => routeRank(path) > routeRank(m) && overlap(path, m)));
  return [...modals, ...shadows]
    .sort((a, b) => routeRank(b) - routeRank(a) || byCodeUnit(a, b))
    .map((path) => (modals.includes(path) ? path : `!${path}`));
}

export function clientNavigationTags(head: ClientNavigationHead): readonly HeadTag[] {
  return [
    {
      kind: 'meta',
      key: `meta:${NAVIGATION_META}`,
      attrs: { name: NAVIGATION_META, content: head.surface },
    },
    {
      kind: 'meta',
      key: `meta:${CLIENT_BUILD_META}`,
      attrs: { name: CLIENT_BUILD_META, content: head.buildId },
    },
    ...(head.modal === true
      ? [
          {
            kind: 'meta' as const,
            key: `meta:${NAVIGATION_PRESENTATION_META}`,
            attrs: { name: NAVIGATION_PRESENTATION_META, content: 'modal' },
          },
        ]
      : []),
    ...(head.modals !== undefined && head.modals.routes.length > 0
      ? [
          {
            kind: 'meta' as const,
            key: `meta:${NAVIGATION_MODALS_META}`,
            attrs: { name: NAVIGATION_MODALS_META, content: JSON.stringify(head.modals) },
          },
        ]
      : []),
    // Deferred, in `<head>`: it runs once, after parsing, and survives every swap of the body.
    {
      kind: 'script',
      key: 'script:ultimate-navigation',
      attrs: { src: head.scriptUrl, defer: true },
    },
  ];
}
