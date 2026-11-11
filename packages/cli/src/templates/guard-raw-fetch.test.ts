// The `raw-fetch` guard as `x new` emits it, run through the gate's own seam: a server `fetch(`
// with no signal in its own options is refused at its line; `{ signal }` and an island are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const PAGE = 'apps/web/app/post/page.tsx';

describe('unit · shipped guard · raw-fetch', () => {
  test('a bare, a globalThis. and a nested-signal fetch are X_RAW_FETCH at their lines', async () => {
    const findings = await shippedGuardFindings('raw-fetch', {
      [PAGE]: [
        'export const load = async () => {',
        "  const a = await fetch('https://api.test/a');",
        "  const b = await globalThis.fetch('https://api.test/b', { method: 'POST' });",
        "  const c = await fetch('https://api.test/c', { env: { signal } });",
        '  return [a, b, c];',
        '};',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_RAW_FETCH', `${PAGE}:2`],
      ['X_RAW_FETCH', `${PAGE}:3`],
      ['X_RAW_FETCH', `${PAGE}:4`],
    ]);
    expect(findings[0]?.fix).toContain('outbound({ url, vendor');
  });

  test('a signal in its own options, an island, a test and an injected fetch are silent', async () => {
    const call = "await fetch('https://api.test/a');\n";
    const findings = await shippedGuardFindings('raw-fetch', {
      [PAGE]: "export const load = () => fetch('https://api.test/a', { signal: ctx.signal });\n",
      'apps/web/app/post/like.island.tsx': call,
      'apps/web/app/post/page.test.ts': call,
      'packages/vendor/src/client.ts':
        "export const get = (deps) => deps.fetch('https://x.test');\n",
      'apps/web/server.ts': 'Bun.serve({ fetch(request) { return new Response(); } });\n',
    });
    expect(findings).toEqual([]);
  });

  test('a fetch the file binds itself is its own; globalThis.fetch( never is', async () => {
    const findings = await shippedGuardFindings('raw-fetch', {
      'apps/web/a.ts': "const { fetch } = deps;\nawait fetch('https://x.test');\n",
      'apps/web/b.ts': "export const get = (fetch: Fetch) => fetch('https://x.test');\n",
      'apps/web/c.ts':
        "import { fetch } from './client';\nawait fetch('https://x.test');\nawait globalThis.fetch('https://x.test');\n",
      'apps/web/d.ts': "export const get = (deps) => fetch('https://x.test');\n",
    });
    expect(findings.map((finding) => finding.at)).toEqual(['apps/web/c.ts:3', 'apps/web/d.ts:1']);
  });
});
