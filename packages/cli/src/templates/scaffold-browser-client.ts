// `apps/web/shared/browser-client.ts` — the two typed clients an island calls, and the test beside
// them. Split from scaffold-api.ts because that file writes the SERVER half of the API surface;
// this is the browser's projection of it, shaped from `api/index.ts`'s `Api` type and nothing else.

import type { GeneratedFile } from './naming';

const browserClient = (): string => `/**
 * The typed clients an ISLAND calls: \`browserClient.health({})\` writes, \`browserQueries.<name>(input)\`
 * reads. Every action and query this app registers is a method here, typed from its own schemas,
 * with no codegen step. The \`Api\` import is type-only, so no module edge reaches a feature's
 * implementation and \`site/\` islands may use these too (\`site/\` may not import \`app/\`).
 *
 * Origin-relative: a browser posts to the page's own origin. No \`pathStyle\` either — the server
 * stamps \`defineApi({ http: { pathStyle } })\` into every document and the client reads it there,
 * so there is nothing here to keep in step.
 *
 * An island never calls \`fetch\`: a raw request in browser code is X_BROWSER_TRANSPORT_BYPASS on
 * \`x verify\`. \`@ultimat3/query/client\`, not the barrel — the barrel carries the server's registry
 * and is X_BROWSER_SERVER_BARREL in a browser chunk.
 */

import { rpc } from '@ultimat3/action';
import { queryClient } from '@ultimat3/query/client';
import type { Api } from '../api';

export const browserClient = rpc<Api['actions']>({ baseUrl: '' });
export const browserQueries = queryClient<Api['queries']>({ baseUrl: '' });
`;

/** The read the example slice registers; `--no-example` registers none, so it asserts none. */
const exampleRead = `
unitTest('browserQueries reads a query over GET, its input in the search string', async () => {
  const seen = await recording(
    () => Response.json([]),
    // No org: the read is the caller's own org, decided on the server from the session.
    () => browserQueries.postList({ limit: 10 }),
  );
  expect(seen.answer).toEqual([]);
  expect(seen.requests).toEqual([{ method: 'GET', url: '/_x/query/post-list?limit=10' }]);
});
`;

const browserClientTest = (
  example: boolean,
): string => `// The island's typed clients reach the server the way the server serves it: an action is a POST to
// its derived path on the page's own origin, a read is a GET under /_x/query. Asserted on the wire
// — the one place a renamed action or a moved origin would show.
import { expect, unitTest } from '@ultimat3/testing';
import { browserClient${example ? ', browserQueries' : ''} } from './browser-client';

interface Sent {
  readonly method: string | undefined;
  readonly url: string;
}

/** Runs \`call\` against a \`fetch\` that records each request and answers with \`respond()\`. */
async function recording<T>(
  respond: () => Response,
  call: () => Promise<T>,
): Promise<{ readonly answer: T; readonly requests: readonly Sent[] }> {
  const requests: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method, url });
    return respond();
  }) as typeof fetch;
  try {
    return { answer: await call(), requests };
  } finally {
    globalThis.fetch = real;
  }
}

unitTest('browserClient posts an action to its derived path on the page origin', async () => {
  const seen = await recording(
    () => Response.json({ ok: true, role: 'web' }),
    () => browserClient.health({}),
  );
  expect(seen.answer).toEqual({ ok: true, role: 'web' });
  expect(seen.requests).toEqual([{ method: 'POST', url: '/api/healths/invoke' }]);
});
${example ? exampleRead : ''}`;

/** The client and its test, in `shared/` because both `site/` and `app/` islands import it. */
export function browserClientFiles(example: boolean): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/shared/browser-client.ts', contents: browserClient() },
    { path: 'apps/web/shared/browser-client.test.ts', contents: browserClientTest(example) },
  ];
}
