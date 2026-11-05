// Single responsibility: where a read is served — its pinned `http.path` (`/orders/:id`) when it
// declares one, else core's `queryPath(name)` — and the check of that pin at `query()`. The
// template rule is core's, shared with `@ultimat3/action`'s pins; only the code is this package's.

import {
  pathTemplateProblem,
  queryPath,
  renderCauseValue,
  templateKeyProblem,
  templateParams,
} from '@ultimat3/core';
import { tryIntrospect } from '@ultimat3/schema';
import { QueryHttpPathInvalidError } from './http-pin-error';
import type { AnyQuery } from './query';
import { defOf } from './read';

/** What a read may say about its own HTTP projection. */
export interface QueryHttp {
  /**
   * Pin the URL instead of `/_x/query/<kebab>`: lowercase static segments and `:param`s, each a
   * REQUIRED string key of `input:`. The URL's value joins the search string as the one input the
   * schema parses; a search string naming the key differently is `X_HTTP_PATH_INPUT_CONFLICT`.
   */
  readonly path?: string;
  /** A read is a `GET`; stated only for symmetry with an action's pin. */
  readonly method?: 'GET';
}

/** Refuses at `query()` a pin no route could serve or no input could fill. */
export function assertQueryHttp(http: QueryHttp | undefined, input: unknown): void {
  if (http === undefined) return;
  const method: unknown = http.method;
  const path: unknown = http.path;
  const shown = renderCauseValue(path);
  if (method !== undefined && method !== 'GET') {
    throw new QueryHttpPathInvalidError({
      name: '',
      path: shown,
      reason: `is declared with http.method ${renderCauseValue(method)}, and a read is a GET`,
    });
  }
  if (path === undefined) {
    if (method === undefined) return;
    throw new QueryHttpPathInvalidError({
      name: '',
      path: shown,
      reason: 'is absent, and http.method has no pinned path to answer on',
    });
  }
  const reason =
    pathTemplateProblem(path) ??
    templateKeyProblem(templateParams(path as string), tryIntrospect(input)?.properties);
  if (reason !== undefined) throw new QueryHttpPathInvalidError({ name: '', path: shown, reason });
}

/** The path `name` is served at: the pin, else the derived `/_x/query/<kebab>`. */
export function servedQueryPath(name: string, http: QueryHttp | undefined): string {
  return http?.path ?? queryPath(name);
}

/** `{ path, method: 'GET' }` exactly when `target` pins its URL — the manifest's fact. */
export function queryHttpPinOf(
  target: AnyQuery,
): { readonly path: string; readonly method: 'GET' } | undefined {
  const path = defOf(target).http?.path;
  return path === undefined ? undefined : { path, method: 'GET' };
}
