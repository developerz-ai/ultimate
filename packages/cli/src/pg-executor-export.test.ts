// Issue #688: an app that needed a `PgExecutor` for its own store restated the boot's. The one
// builder is `@ultimat3/db`'s `dbExecutor` — the boot builds every executor of its own with it —
// so the CLI barrel, the surface an app imports, must not grow a second spelling.

import { expect, test } from 'bun:test';

test('the barrel carries no pgExecutorFor: the one builder is @ultimat3/db’s dbExecutor', async () => {
  const barrel: Record<string, unknown> = await import('./index');
  expect(Object.hasOwn(barrel, 'pgExecutorFor')).toBe(false);
});
