/**
 * What an opted-in document carries for the client router: which surface rendered it, which build
 * (the skew check — the same meta realtime's sync tags write, deduped by key), the router's
 * script, and — for a `navigation: 'modal'` route — that it is presented over another page. A
 * surface that did not opt in gets none of them, so it pays no byte.
 */

import { CLIENT_BUILD_META } from '@ultimat3/core';
import type { HeadTag } from './head';
import { NAVIGATION_PRESENTATION_META } from './navigation-modal-rules';
import { NAVIGATION_META } from './navigation-rules';

export interface ClientNavigationHead {
  /** The surface this document belongs to — a link that lands on another is a full load. */
  readonly surface: string;
  readonly buildId: string;
  /** `/_x/navigation/<hash>.js`, content-addressed and served `immutable`. */
  readonly scriptUrl: string;
  /** The route declared `navigation: 'modal'`: the router shows it over the page beneath. */
  readonly modal?: boolean;
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
    // Deferred, in `<head>`: it runs once, after parsing, and survives every swap of the body.
    {
      kind: 'script',
      key: 'script:ultimate-navigation',
      attrs: { src: head.scriptUrl, defer: true },
    },
  ];
}
