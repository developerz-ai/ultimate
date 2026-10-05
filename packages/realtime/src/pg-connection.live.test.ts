// The session pins it opens, against a real Postgres whose defaults disagree with them. A scripted
// server proves the startup packet carries `-c TimeZone=UTC`; only a real one proves the server
// takes it over a role default — on a walsender too — and that the text it then writes is the
// text `pg-values.ts` reads as the instant Bun's driver hands the repository.
//
// Skips unless a server is configured: `set -a; . docker/test-services.env; set +a`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';
import { decodeValue } from './pg-values';

const url =
  Bun.env['TEST_REPLICATION_URL'] ?? Bun.env['TEST_DATABASE_URL'] ?? Bun.env['DATABASE_URL'];

const TIMESTAMPTZ = 1184;
/** A role whose server-side default is a zone with a pre-1883 LMT offset to the second. */
const ROLE = 'x_live_tz_role';
const PASSWORD = 'x_live_tz_password';
/** `America/New_York` writes this instant as `1880-01-01 07:03:58-04:56:02`. */
const LMT_INSTANT = `'1880-01-01 12:00:00+00'::timestamptz`;

const connect = async (
  as: { user: string; password: string },
  replication?: 'database',
): Promise<PgConnection> => {
  const target = parsePgUrl(url ?? '');
  return PgConnection.open({
    stream: await bunPgStream(target),
    user: as.user,
    password: as.password,
    database: target.database,
    applicationName: 'ultimate-live-test',
    replication,
  });
};

const admin = (): Promise<PgConnection> => {
  const target = parsePgUrl(url ?? '');
  return connect({ user: target.user, password: target.password ?? '' });
};

const describeLive = url === undefined ? describe.skip : describe;

describeLive('live · pg connection session pins', () => {
  beforeAll(async () => {
    const session = await admin();
    try {
      await session.query(`DROP ROLE IF EXISTS ${ROLE}`);
      await session.query(`CREATE ROLE ${ROLE} LOGIN REPLICATION PASSWORD '${PASSWORD}'`);
      await session.query(`ALTER ROLE ${ROLE} SET TimeZone = 'America/New_York'`);
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = await admin();
    try {
      await session.query(`DROP ROLE IF EXISTS ${ROLE}`);
    } finally {
      await session.close();
    }
  });

  for (const replication of [undefined, 'database'] as const) {
    test(`a non-UTC server default still writes UTC text (${replication ?? 'plain'} session)`, async () => {
      const session = await connect({ user: ROLE, password: PASSWORD }, replication);
      try {
        expect(session.parameter('TimeZone')).toBe('UTC');
        const [row] = await session.query(`SELECT ${LMT_INSTANT}::text`);
        expect(row?.[0]).toBe('1880-01-01 12:00:00+00');
      } finally {
        await session.close();
      }
    });
  }

  test('the seconds offset a non-UTC session writes decodes to the repository instant', async () => {
    // The decoder's half, held on the server's own text rather than a hand-typed fixture: a
    // session that overrides the pin is the one way left to receive a seconds offset.
    const session = await connect({ user: ROLE, password: PASSWORD });
    try {
      await session.query(`SET TimeZone = 'America/New_York'`);
      const [row] = await session.query(`SELECT ${LMT_INSTANT}::text`);
      const text = row?.[0] ?? '';
      expect(text).toBe('1880-01-01 07:03:58-04:56:02');

      const sql = new Bun.SQL(url ?? '');
      try {
        const [repo] = await sql`SELECT ${sql.unsafe(LMT_INSTANT)} AS v`;
        expect(decodeValue(TIMESTAMPTZ, text)).toEqual(repo.v);
      } finally {
        await sql.close();
      }
    } finally {
      await session.close();
    }
  });
});
