// The one pair of errors an app meets before it meets any other: `x db migrate` reports drift
// because the newest migration carries no snapshot, and `x db gen` refuses for the same reason.
// Reproduced on a pristine `x new` scaffold — `x db migrate` said `x db gen "snapshot initial"`,
// and `x db gen` answered "restore … from version control" for a file version control never had.
// Both instructions must lead OUT: neither may name the command that raises the other.

import { describe, expect, test } from 'bun:test';
import { checkDrift } from './drift';
import { migrationSnapshotMissing } from './errors';
import { createRecordingClient } from './fake';

const FILE = 'packages/db/migrations/0000_initial.snapshot.json';

describe('unit · X_MIGRATION_SNAPSHOT_MISSING names a command that can be run', () => {
  const error = migrationSnapshotMissing('0000_initial', FILE);

  test('restoring the sidecar is a command, not a sentence', () => {
    expect(error.fix).toContain(`git checkout -- ${FILE}`);
  });

  test('the second remedy deletes the migration BEFORE regenerating it', () => {
    // `x db gen` on a migration whose sidecar is still missing raises this same error: naming it
    // first is the cycle. The files go, then the generator runs against what is left.
    const remove = error.fix.indexOf('rm packages/db/migrations/0000_initial.*');
    const generate = error.fix.indexOf('x db gen');
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(generate).toBeGreaterThan(remove);
  });

  test('the cause names the file that is missing', () => {
    expect(error.cause).toContain(FILE);
    expect(error.code).toBe('X_MIGRATION_SNAPSHOT_MISSING');
  });

  test('the migration name is recovered from the id, so `x db gen` gets a sensible argument', () => {
    expect(migrationSnapshotMissing('20260817120000_add_posts', FILE).fix).toContain(
      'x db gen "add_posts"',
    );
    // An id carrying no stamp is still an id; the fallback must never be an empty argument.
    expect(migrationSnapshotMissing('legacy', FILE).fix).toContain('x db gen "legacy"');
  });
});

describe('unit · the drift difference points the same way', () => {
  test('unknown-schema does not answer with the command that raises the other error', async () => {
    // Before: `x db gen "snapshot initial"   # or restore its .snapshot.json sidecar`. Running the
    // command it leads with is X_MIGRATION_SNAPSHOT_MISSING, whose own fix pointed back here.
    const client = createRecordingClient().on('from x_migrations', {
      rows: [
        {
          id: '0000_initial',
          name: 'initial',
          checksum: 'x',
          applied_at: '2026-08-17T00:00:00Z',
          app_version: 'dev',
          duration_ms: 1,
        },
      ],
    });
    const report = await checkDrift({
      client,
      migrations: [{ id: '0000_initial', name: 'initial', up: '', down: '' }],
    });
    const fix = report.differences[0]?.fix ?? '';
    expect(report.differences[0]?.kind).toBe('unknown-schema');
    expect(fix.startsWith('x db gen')).toBe(false);
    expect(fix).toContain('git checkout -- "*0000_initial.snapshot.json"');
    expect(fix.indexOf('x db gen')).toBeGreaterThan(fix.indexOf('delete'));
  });
});
