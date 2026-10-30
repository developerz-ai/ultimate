// The README's scaler statement is the one `scaler-depth.job.test.ts` proves on Postgres: an
// operator copies the README into a ScaledObject, so a fix to one that missed the other would ship
// the unproved one. Compared token for token, with the README's inlined queue list as `$1`.

import { describe, expect, test } from 'bun:test';
import { SQL_SCALER_DEPTH } from './scaler-depth-fixture';

const tokens = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('the README scaler statement', () => {
  test('is the proved one', async () => {
    const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
    const block = /\*\*A scaler reading Postgres\*\*[\s\S]*?```sql\n([\s\S]*?)```/.exec(
      readme,
    )?.[1];
    if (block === undefined) return expect.unreachable('the README has its scaler block');
    expect(tokens(block.replace(/any\('\{[^}]*\}'::text\[\]\)/, 'any($1::text[])'))).toBe(
      tokens(SQL_SCALER_DEPTH),
    );
  });
});
