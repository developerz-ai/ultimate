// Single responsibility: the URL's `:param` values merged into a request's input, and the one
// refusal when the two disagree (`X_HTTP_PATH_INPUT_CONFLICT`). Server-side only: the template
// helpers it reads are `route-path-template.ts`, which a browser client loads without this.

import { UltimateError } from './errors';
import { templateParams } from './route-path-template';

/**
 * The URL disagreed with the body (or search string) about one key. Never resolved by letting
 * either win: a policy reading one id while the handler reads another is the bug this refuses.
 */
export class HttpPathInputConflictError extends UltimateError {
  constructor(input: { readonly owner: string; readonly template: string; readonly key: string }) {
    super({
      code: 'X_HTTP_PATH_INPUT_CONFLICT',
      cause: `${input.owner} is served at ${input.template}, and the request sent ${input.key} both as the URL's :${input.key} and, with a different value, in its body or query string`,
      fix: `{} — the body (or query string) without ${input.key}: the URL already carries it; or send the identical value in both`,
      meta: { key: input.key, path: input.template },
    });
  }
}

/**
 * The input `invoke`/`runQuery` parses: the template's params, taken from the router's DECODED
 * `params`, merged into `raw`. A key both carry must agree exactly, else
 * `X_HTTP_PATH_INPUT_CONFLICT`. A `raw` that is not a keyed object is handed on untouched — the
 * input's own schema refuses it with the code every surface answers.
 */
export function mergePathParams(input: {
  readonly owner: string;
  readonly template: string;
  readonly params: Readonly<Record<string, string>>;
  readonly raw: unknown;
}): unknown {
  const names = templateParams(input.template);
  if (names.length === 0) return input.raw;
  const { raw } = input;
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return raw;
  }
  const fields: Record<string, unknown> = { ...(raw ?? {}) };
  for (const name of names) {
    const fromUrl = input.params[name];
    if (fromUrl === undefined) continue;
    if (Object.hasOwn(fields, name) && fields[name] !== fromUrl) {
      throw new HttpPathInputConflictError({
        owner: input.owner,
        template: input.template,
        key: name,
      });
    }
    fields[name] = fromUrl;
  }
  return fields;
}
