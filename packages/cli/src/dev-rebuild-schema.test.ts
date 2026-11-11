// Entities ahead of the migrations, said by the generation: the instruction is the whole one —
// generate AND migrate, since `x dev` applies no migration — and a failed check never fails a boot.

import { describe, expect, test } from 'bun:test';
import { SCHEMA_AHEAD_FIX, schemaAheadFindings } from './dev-rebuild-schema';
import type { Finding } from './output';

const drift: Finding = {
  code: 'X_DB_DRIFT',
  cause: 'schema hashes to abc, newest migration 0001_init.hash recorded def',
  fix: 'x db gen "describe the change"',
  at: 'packages/db/src',
};

describe('schemaAheadFindings', () => {
  test('a drifted schema is X_DB_DRIFT with the gen-and-migrate instruction', async () => {
    const [finding] = await schemaAheadFindings('/app', async () => [drift]);
    expect(finding?.code).toBe('X_DB_DRIFT');
    expect(finding?.cause).toBe(`entities are ahead of the migrations: ${drift.cause}`);
    expect(finding?.fix).toBe('x db gen "describe the change" && x db migrate');
    expect(finding?.at).toBe('packages/db/src');
    expect(SCHEMA_AHEAD_FIX).toContain('x db migrate');
  });

  test('a schema the migrations recorded says nothing', async () => {
    expect(await schemaAheadFindings('/app', async () => [])).toEqual([]);
  });

  test('a check that throws is a finding, never a rejection', async () => {
    const findings = await schemaAheadFindings('/app', () =>
      Promise.reject(new TypeError('hash sidecar unreadable')),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('hash sidecar unreadable');
  });
});
