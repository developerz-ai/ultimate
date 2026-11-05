// Single responsibility: an `http.path` TEMPLATE (`/orders/:id/refund`) — shape, params, the input
// keys they must name, filling, OpenAPI spelling. Here because `@ultimat3/action` and `@ultimat3/query`
// share a tier. Imports nothing, so a browser client fills a URL without an error class; the merge
// and its refusal are `route-path-merge.ts`.

/** Lowercase static segments or `:camelName` params; no wildcard, no trailing slash. */
const PATH_TEMPLATE = /^(\/([a-z0-9][a-z0-9._~-]*|:[a-z][A-Za-z0-9]*))+$/;

/**
 * Why `path` cannot be a pin, or `undefined` when it can. A reason, not a throw: each package
 * refuses with its own code (`X_ACTION_HTTP_PATH_INVALID`, `X_QUERY_HTTP_PATH_INVALID`).
 */
export function pathTemplateProblem(path: unknown): string | undefined {
  if (typeof path !== 'string') return 'is not a string';
  // Before the pattern, which refuses `_` too: the namespace is the reason a reader can act on.
  if (path === '/_x' || path.startsWith('/_x/')) return 'claims /_x, the framework namespace';
  if (!PATH_TEMPLATE.test(path)) {
    return 'is not a lowercase path of static segments and :camelCase params (an uppercase letter, a *wildcard or a trailing slash)';
  }
  const seen = new Set<string>();
  for (const param of templateParams(path)) {
    if (seen.has(param)) return `repeats :${param}, and one URL cannot carry two values for it`;
    seen.add(param);
  }
  return undefined;
}

/** `/orgs/:orgId/posts/:postId` → `['orgId', 'postId']`, in order. */
export function templateParams(path: string): readonly string[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
}

/** `:id` → `{id}`: OpenAPI's spelling of the same template. A static path is unchanged. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([a-z][A-Za-z0-9]*)/g, '{$1}');
}

/** The slice of an introspected input member the key rule reads — `@ultimat3/schema`'s node. */
export interface TemplateKeyNode {
  readonly kind?: string;
  readonly optional?: boolean | undefined;
  readonly hasDefault?: boolean | undefined;
}

/**
 * Why `params` cannot be filled from an input with these top-level `properties`, or `undefined`.
 * Every param must be a REQUIRED string key: the value is merged into the input before it is
 * parsed, so the input's own schema validates it — an optional key would be a URL with a hole.
 */
export function templateKeyProblem(
  params: readonly string[],
  properties: Readonly<Record<string, TemplateKeyNode>> | undefined,
): string | undefined {
  if (params.length === 0) return undefined;
  if (properties === undefined) {
    return 'names a :param, and input: cannot be introspected to prove it carries that key';
  }
  for (const param of params) {
    const node = Object.hasOwn(properties, param) ? properties[param] : undefined;
    if (node === undefined) return `names :${param}, which is not a key of input:`;
    if (node.kind !== 'string') return `names :${param}, whose input: member is not a string`;
    if (node.optional === true || node.hasDefault === true) {
      return `names :${param}, whose input: member is optional — a URL cannot omit a segment`;
    }
  }
  return undefined;
}

export type FilledTemplate =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly missing: string };

/**
 * The template with every `:param` replaced by `input[param]`, `encodeURIComponent`-ed so a `/` in
 * a value stays inside its one segment — the router decodes it back into the same one param.
 * A missing, empty or non-string value is named rather than spelled into a different URL.
 */
export function fillTemplate(path: string, input: unknown): FilledTemplate {
  const values = typeof input === 'object' && input !== null ? input : {};
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment.startsWith(':')) {
      out.push(segment);
      continue;
    }
    const name = segment.slice(1);
    const value = Object.hasOwn(values, name)
      ? (values as Record<string, unknown>)[name]
      : undefined;
    if (typeof value !== 'string' || value === '') return { ok: false, missing: name };
    out.push(encodeURIComponent(value));
  }
  return { ok: true, path: out.join('/') };
}
