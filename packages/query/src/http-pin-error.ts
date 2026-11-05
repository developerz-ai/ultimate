// Single responsibility: `X_QUERY_HTTP_PATH_INVALID`, the refusal of a read's pinned `http.path`.
// Its own leaf over `@ultimat3/core/page`, so the browser read client can refuse a URL it cannot
// fill without loading `errors.ts`'s titles table (`client-bundle.test.ts`); the title is there.

import { UltimateError } from '@ultimat3/core/page';

export class QueryHttpPathInvalidError extends UltimateError {
  constructor(input: { readonly name: string; readonly path: string; readonly reason: string }) {
    super({
      code: 'X_QUERY_HTTP_PATH_INVALID',
      cause: `query${input.name === '' ? '' : ` "${input.name}"`} pins http.path ${input.path}, which ${input.reason}`,
      // Short on purpose: this class rides the browser read client (`client-bundle.test.ts`).
      fix: "query({ input: t.object({ id: t.string }), http: { path: '/orders/:id' }, ... }) — every :param a required t.string key of input:, and passed to client()",
      meta: { query: input.name },
    });
  }
}
