// `x g purge`'s unit suite, RUN: it answers `X_ENTITY_RETAIN_UNSWEPT`, so the app that generates
// it declares a `retain` — and the pass over one is SQL on the ambient Postgres client. The suite
// it wrote ran that pass with no database and was red on `unit` for every app that needed it.

import { afterAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { processRoot } from '../process-root-fixture';
import { purgeFiles } from './generate-purge';

// Under `packages/cli/` so `@ultimat3/*` resolves through the framework's own tsconfig paths.
const root = processRoot(join(import.meta.dir, '..', '..', '.purge-template-fixture'));
const SLICE = 'apps/web/app/posts';

// One entity that declares `retain`, registered before the generated suite is: what `entities:
// 'declared'` sweeps, and what turned the old suite's pass into a statement with no database.
const RETAINED = `import { entity, text, timestamp, uuid } from '@ultimat3/entity';
export const runEvents = entity('run_events', {
  columns: { id: uuid().primaryKey(), note: text(), at: timestamp().defaultNow() },
  indexes: [{ on: ['at'] }],
  retain: { after: '90d', on: 'at' },
});
`;

afterAll(() => rm(root, { recursive: true, force: true }));

test('the generated purge unit suite passes in an app with one retain entity and no DATABASE_URL', async () => {
  for (const file of purgeFiles('old-posts', { surfaceDir: 'apps/web/app', feature: 'posts' })) {
    if (typeof file.contents === 'string') await Bun.write(join(root, file.path), file.contents);
  }
  await Bun.write(join(root, SLICE, 'jobs/retained.ts'), RETAINED);
  await Bun.write(
    join(root, SLICE, 'jobs/with-retain.test.ts'),
    "import './retained';\nimport './old-posts.test';\n",
  );
  const { DATABASE_URL: _unset, ...env } = Bun.env;
  const child = Bun.spawn(['bun', 'test', join(root, SLICE, 'jobs/with-retain.test.ts')], {
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(output).toContain('1 pass');
  expect(output).toContain('0 fail');
  expect(code).toBe(0);
}, 120_000);
