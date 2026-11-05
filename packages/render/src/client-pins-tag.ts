/**
 * Every pinned action and query the server serves, as a `<head>` tag:
 * `<meta name="ultimate-pins" content="…">`, read by `@ultimat3/core`'s `renderedActionPin` /
 * `renderedQueryPin` for every browser caller that reaches one by NAME. Principal-free, so every
 * document may carry it — and an app that pins nothing writes no tag and renders the same bytes.
 */

import type { ClientPins } from '@ultimat3/core';
import { CLIENT_PINS_META, encodeClientPins } from '@ultimat3/core';
import type { HeadTag } from './head';

/** `pins` is what the server's registries declare, read per render — `defineApi` may run late. */
export function clientPinTags(pins: ClientPins): readonly HeadTag[] {
  const content = encodeClientPins(pins);
  if (content === undefined) return [];
  return [
    {
      kind: 'meta',
      key: `meta:${CLIENT_PINS_META}`,
      attrs: { name: CLIENT_PINS_META, content },
    },
  ];
}
