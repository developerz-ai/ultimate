/**
 * How this server turns an action's name into its URL, as a `<head>` tag:
 * `<meta name="ultimate-path-style" content="readable">`, read by `@ultimat3/core`'s `actionPath`
 * for every browser caller that names no style. Principal-free, so every document may carry it —
 * and only a non-default style is written: an app that declared none renders the same bytes.
 */

import type { ActionPathStyle } from '@ultimat3/core';
import { CLIENT_PATH_STYLE_META } from '@ultimat3/core';
import type { HeadTag } from './head';

/** The `name` core's reader matches — core's constant, so the writer and the reader are one literal. */
export { CLIENT_PATH_STYLE_META };

/** `style` is `@ultimat3/action`'s `actionPathStyle()`: what `defineApi` declared, read per render. */
export function clientPathStyleTags(style: ActionPathStyle): readonly HeadTag[] {
  if (style === 'resource') return [];
  return [
    {
      kind: 'meta',
      key: `meta:${CLIENT_PATH_STYLE_META}`,
      attrs: { name: CLIENT_PATH_STYLE_META, content: style },
    },
  ];
}
