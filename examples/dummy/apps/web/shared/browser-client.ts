/**
 * The typed action client an ISLAND calls — `browserClient.savePreferences(input)`. Same `rpc()`
 * and the same `Api` type as `client.ts`, but origin-relative: a browser posts to the page's own
 * origin, and `process.env['APP_URL']` does not exist in a browser chunk. Every call goes through
 * `@ultimat3/core`'s one transport, so the record envelope reaches the page store with no code here.
 *
 * In `shared/` so `site/` islands can use it too: `site/` may not import `app/` (axiom 6), and the
 * `Api` import is type-only, so no module edge reaches a feature's implementation.
 */

import { rpc } from '@ultimat3/action';
import type { Api } from '../api';

export const browserClient = rpc<Api['actions']>({ baseUrl: '' });
