/**
 * The typed client. `Api` is imported **as a type only**, so no module-graph edge exists from a
 * page to a feature's implementation — which is what keeps `site/` at 0kb and makes the
 * `site/` → `app/` boundary checkable rather than aspirational.
 *
 * There is no codegen step to remember: the shape is inferred from the action declarations.
 */

import { rpc } from '@ultimat3/action';
import type { Api } from '../api';

export const client = rpc<Api>();
