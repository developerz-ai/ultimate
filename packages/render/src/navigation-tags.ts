/**
 * What an opted-in document carries for the client router: which surface rendered it, which build
 * (the skew check — the same meta realtime's sync tags write, deduped by key), and the router's
 * script. A surface that did not opt in gets none of the three, so it pays no byte.
 */

import { CLIENT_BUILD_META } from '@ultimat3/core';
import type { HeadTag } from './head';
import { NAVIGATION_META } from './navigation-rules';

export interface ClientNavigationHead {
  /** The surface this document belongs to — a link that lands on another is a full load. */
  readonly surface: string;
  readonly buildId: string;
  /** `/_x/navigation/<hash>.js`, content-addressed and served `immutable`. */
  readonly scriptUrl: string;
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
    // Deferred, in `<head>`: it runs once, after parsing, and survives every swap of the body.
    {
      kind: 'script',
      key: 'script:ultimate-navigation',
      attrs: { src: head.scriptUrl, defer: true },
    },
  ];
}
