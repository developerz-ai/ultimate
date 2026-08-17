/**
 * The one naming rule for reads: a query's export name derives its HTTP path.
 * Pure string math, so the browser client derives the same URL without importing
 * a byte of server code. Ported rather than imported from @ultimat3/action: that
 * package is the same tier, and tiers never go sideways. The MCP tool name is NOT
 * derived — it is the export name verbatim, so there is one name to call.
 */

/** Every read is served under one prefix, so a router can claim it in one rule. */
const QUERY_PREFIX = '/_x/query';

/** camelCase / PascalCase / SCREAMING_SNAKE -> lowercase words. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/** `liveFeed` -> `live-feed`. */
export function toKebabCase(name: string): string {
  return splitWords(name).join('-');
}

/**
 * `liveFeed` -> `/_x/query/live-feed`, read with `GET …?orgId=…`. A read is a GET
 * under its own prefix so a CDN, a browser cache and a log line can all tell it
 * apart from an action's `POST /api/...` without parsing a body.
 */
export function derivePath(name: string): string {
  return `${QUERY_PREFIX}/${toKebabCase(name)}`;
}
