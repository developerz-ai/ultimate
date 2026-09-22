/**
 * The naming rule for reads, as this package has always exported it: a query's export name
 * derives its HTTP path. The rule itself is `@ultimat3/core`'s `client-paths.ts` — one tier-0 file
 * that `action`, `query` and `realtime` all read, so the path cannot be derived two ways. The MCP
 * tool name is NOT derived — it is the export name verbatim, so there is one name to call.
 */

import { queryPath, splitWords } from '@ultimat3/core/page';

export { splitWords };

/** `liveFeed` -> `live-feed`. */
export function toKebabCase(name: string): string {
  return splitWords(name).join('-');
}

/**
 * `liveFeed` -> `/_x/query/live-feed`, read with `GET …?orgId=…`. A read is a GET under its own
 * prefix so a CDN, a browser cache and a log line can all tell it apart from an action's
 * `POST /api/...` without parsing a body.
 */
export const derivePath: (name: string) => string = queryPath;
