/**
 * The typed clients an ISLAND calls: `browserClient.health({})` writes, `browserQueries.<name>(input)`
 * reads. Every action and query this app registers is a method here, typed from its own schemas,
 * with no codegen step. The `Api` import is type-only, so no module edge reaches a feature's
 * implementation and `site/` islands may use these too (`site/` may not import `app/`).
 *
 * Origin-relative: a browser posts to the page's own origin. No `pathStyle` either — the server
 * stamps `defineApi({ http: { pathStyle } })` into every document and the client reads it there,
 * so there is nothing here to keep in step.
 *
 * An island never calls `fetch`: a raw request in browser code is X_BROWSER_TRANSPORT_BYPASS on
 * `x verify`. `@ultimat3/query/client`, not the barrel — the barrel carries the server's registry
 * and is X_BROWSER_SERVER_BARREL in a browser chunk.
 */

import { rpc } from '@ultimat3/action';
import { queryClient } from '@ultimat3/query/client';
import type { Api } from '../api';

export const browserClient = rpc<Api['actions']>({ baseUrl: '' });
export const browserQueries = queryClient<Api['queries']>({ baseUrl: '' });
