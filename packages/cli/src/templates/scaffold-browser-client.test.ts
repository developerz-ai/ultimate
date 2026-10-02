// What `x new` writes for an island to call the server with: both typed clients over the `Api`
// TYPE, no `pathStyle`, the browser entry of the query client — and a test beside them, because a
// scaffolded app is held to a coverage floor over its own source from its first `x verify`.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';

/** One emitted file's text; `''` when the scaffold does not write it. */
function emitted(path: string, example: boolean): string {
  const file = planNewApp({ name: 'demo-app', example }).find(
    (candidate) => candidate.path === path,
  );
  return typeof file?.contents === 'string' ? file.contents : '';
}

for (const example of [false, true]) {
  const variant = example ? '--example' : '--no-example';
  const client = (): string => emitted('apps/web/shared/browser-client.ts', example);
  const suite = (): string => emitted('apps/web/shared/browser-client.test.ts', example);

  describe(`unit · x new ${variant} · the island's typed clients`, () => {
    test('both halves are written, over the Api type and nothing else', () => {
      expect(client()).toContain(
        "export const browserClient = rpc<Api['actions']>({ baseUrl: '' });",
      );
      expect(client()).toContain(
        "export const browserQueries = queryClient<Api['queries']>({ baseUrl: '' });",
      );
      expect(client()).toContain("import type { Api } from '../api';");
      // A value import would put every feature's server code in the island's bundle graph.
      expect(client()).not.toMatch(/^import \{[^}]*\} from '\.\.\/api';$/m);
      expect(emitted('apps/web/api/index.ts', example)).toContain('export type Api = typeof api;');
    });

    test('the path style is stated nowhere — the server stamps it into the document', () => {
      expect(client()).not.toMatch(/pathStyle\s*:/);
    });

    test('the read client is the browser entry, never the barrel a browser chunk is refused', () => {
      expect(client()).toContain("from '@ultimat3/query/client';");
      expect(client()).not.toMatch(/from '@ultimat3\/query';/);
    });

    test('a test ships beside it, and names only what this variant registers', () => {
      expect(suite()).toContain("unitTest('browserClient posts an action");
      expect(suite()).toContain("url: '/api/healths/invoke'");
      // `--no-example` registers no query: asserting one would be a type error in the new app.
      expect(suite().includes('browserQueries.postList(')).toBe(example);
      expect(suite().includes('browserQueries')).toBe(example);
    });
  });
}
