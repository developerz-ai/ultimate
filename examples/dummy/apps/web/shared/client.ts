/**
 * The typed client. `Api` is imported **as a type only**, so no module-graph edge exists from a
 * page to a feature's implementation — which is what keeps `site/` at 0kb and makes the
 * `site/` → `app/` boundary checkable rather than aspirational.
 *
 * There is no codegen step to remember: the shape is inferred from the action declarations. The
 * build id travels on every call, so a page left open across a deploy raises `X_CONTRACT_DRIFT`
 * instead of silently posting to an operation that changed shape.
 */

import { createClient } from '@ultimat3/action';
import type { Api } from '../api';

export const client = createClient<Api['actions']>({
  baseUrl: process.env['APP_URL'] ?? '',
  ...(process.env['BUILD_ID'] === undefined ? {} : { buildId: process.env['BUILD_ID'] }),
});
