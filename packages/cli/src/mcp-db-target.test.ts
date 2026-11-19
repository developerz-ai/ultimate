// The database target as `resolveServices` really builds it, not as a test spells it: an embedded
// checkout is never a branch, so `db.migrate` over MCP refuses (`X_MCP_NOT_BRANCH_DB`) before the
// host opens the directory a running `x dev` holds — the one writer PGlite takes.

import { describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { assertBranchDatabase } from '@ultimat3/mcp';
import { databaseTarget } from './mcp-db-target';
import { resolveServices } from './runtime-bindings';
import { thrownBy } from './thrown-by-fixture';

describe('unit · the MCP database target of an embedded checkout', () => {
  test('is never a branch, wherever the state directory is, so db.migrate refuses unopened', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-mcp-target-'));
    try {
      for (const env of [{}, { ULTIMATE_STATE_DIR: join(root, 'state-feature') }]) {
        const services = resolveServices(root, env);
        expect(services.db.mode).toBe('embedded');
        const target = databaseTarget(services, env);
        expect(target.branch).toBeNull();
        expect(thrownBy(() => assertBranchDatabase(target)).code).toBe('X_MCP_NOT_BRANCH_DB');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
