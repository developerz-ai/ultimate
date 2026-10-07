// The server half of the engine rule, against a real Postgres: migrations that create an
// extension the embedded database cannot link are replayed in a scratch database this module
// creates and drops. `pgstattuple` is the stand-in — in every Postgres' contrib, in no PGlite.

import { afterAll, describe, expect, test } from 'bun:test';
import { type Migration, postgresClient, raw } from '@ultimat3/db';
import { chooseReplayEngine } from './db-replay-engine';
import { replaySchema } from './db-schema-dump';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_init',
    name: 'init',
    up: 'create extension pgstattuple; create table notes (id uuid primary key, body text not null);',
    down: '',
  },
];

describe.skipIf(!hasPostgres)('replaySchema · a real Postgres', () => {
  const admin = postgresClient({ url: url ?? '' });

  afterAll(async () => {
    await admin.close();
  });

  test('the installed PGlite cannot link it, so the rule picks the server', async () => {
    const engine = await chooseReplayEngine(MIGRATIONS, { TEST_DATABASE_URL: url });
    expect(engine).toMatchObject({ kind: 'postgres', requires: ['pgstattuple'] });
  });

  test('replays, dumps, loads back equal, and leaves no scratch database behind', async () => {
    const replayed = await replaySchema(MIGRATIONS, {
      reload: true,
      env: { TEST_DATABASE_URL: url },
    });
    const paths = replayed.files.map((file) => file.path);
    expect(paths).toContain('01_extensions/pgstattuple.sql');
    expect(paths).toContain('04_tables/notes.sql');
    expect(paths).toContain('framework/04_tables/x_migrations.sql');
    // The extension's own functions are not app schema on a server either.
    expect(paths.some((path) => path.startsWith('08_functions/'))).toBe(false);
    expect(replayed.reload).toEqual([]);
    const left = await admin.query<{ datname: string }>(
      raw(
        `select datname from pg_database where datname like 'x\\_schema\\_dump\\_${process.pid}\\_%'`,
      ),
    );
    expect(left).toEqual([]);
  }, 60_000);
});
