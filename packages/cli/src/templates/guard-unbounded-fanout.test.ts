// The `unbounded-fanout` guard as `x new` emits it, run through the gate's own seam: a database
// call per element of a list, all at once, is refused at its line with the `mapBounded` call to
// write; an array literal, a call with no database in it, a `// why:` and a test are silent.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const SERVICE = 'apps/web/app/posts/service.ts';

describe('unit · shipped guard · unbounded-fanout', () => {
  test('Promise.all over a list with a db call is X_UNBOUNDED_FANOUT, naming mapBounded', async () => {
    const findings = await shippedGuardFindings('unbounded-fanout', {
      [SERVICE]: [
        "import { db } from '@app/db';",
        'export const touchAll = async (rows: readonly { id: string }[]) =>',
        '  Promise.all(',
        '    rows.map(async (row) => {',
        '      await db.posts.update(row.id, { title: "x" });',
        '    }),',
        '  );',
        '',
      ].join('\n'),
      'packages/domain/src/sweep.ts':
        'export const sweep = (ids: string[]) => Promise.allSettled(ids.map(async (id) => tx.posts.delete(id)));\n',
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_UNBOUNDED_FANOUT', `${SERVICE}:3`],
      ['X_UNBOUNDED_FANOUT', 'packages/domain/src/sweep.ts:1'],
    ]);
    expect(findings[0]?.fix).toStartWith(
      'mapBounded(rows, <the same async callback>, { width: 8 })',
    );
    expect(findings[0]?.fix).toContain('@ultimat3/core');
  });

  test('a literal list, no database, a why:, a comment and a test are silent', async () => {
    const fanout = 'Promise.all(rows.map(async (row) => db.posts.byId(row)));\n';
    const findings = await shippedGuardFindings('unbounded-fanout', {
      [SERVICE]: [
        'Promise.all([a, b].map(async (one) => db.posts.byId(one)));',
        'Promise.all(urls.map(async (url) => fetchHash(url)));',
        '// why: three locales, fixed by the catalog',
        'Promise.all(locales.map(async (locale) => db.labels.byId(locale)));',
        `// ${fanout}`,
        '',
      ].join('\n'),
      'apps/web/app/posts/service.test.ts': fanout,
    });
    expect(findings).toEqual([]);
  });
});
