// The replicator's own wire client over REAL TLS: libpq's sslmode against a server whose
// certificate is signed by a private CA — the shape of every CNPG cluster, where `prefer` used to
// fail on a verification it never asked for and a trusted CA still hung the in-band read path.
//
// Skips unless a TLS server with `wal_level = logical` and its CA are configured. Locally:
//
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 30 -subj /CN=ca
//   openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=localhost
//   printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > san.ext
//   openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt \
//     -days 30 -extfile san.ext
//   docker run -d --name x-pg-tls -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -p 5440:5432 -v "$PWD":/certs:ro --entrypoint sh postgres:17-alpine -c 'cp /certs/server.* \
//     /tmp/ && chown postgres /tmp/server.* && chmod 600 /tmp/server.key && exec \
//     docker-entrypoint.sh postgres -c wal_level=logical -c ssl=on \
//     -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key'
//   TEST_TLS_REPLICATION_URL=postgres://ultimate:ultimate@localhost:5440/postgres \
//   TEST_TLS_ROOT_CERT="$PWD/ca.crt" bun test packages/realtime/src/pg-tls.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, entityForTable, text } from '@ultimat3/entity';
import type { ChangeEvent } from './changefeed';
import { PgLogicalReplicationFeed } from './changefeed';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';

const base = Bun.env['TEST_TLS_REPLICATION_URL'];
const rootCert = Bun.env['TEST_TLS_ROOT_CERT'];

const TABLE = 'x_tls_live_posts';
const SLOT = 'x_tls_live_slot';
const PUBLICATION = 'x_tls_live_pub';

/** The same server under another query string (and, for the host-name case, another host). */
const urlWith = (query: string, host?: string): string => {
  const url = new URL(base ?? '');
  url.search = query;
  if (host !== undefined) url.hostname = host;
  return url.toString();
};

const connect = async (url: string): Promise<PgConnection> => {
  const target = parsePgUrl(url);
  return PgConnection.open({
    stream: await bunPgStream(target),
    user: target.user,
    password: target.password,
    database: target.database,
    applicationName: 'ultimate-tls-live-test',
  });
};

/** Whether THIS session is encrypted — asked of the server, never inferred from the mode. */
const encrypted = async (url: string): Promise<string | null | undefined> => {
  const connection = await connect(url);
  try {
    const [row] = await connection.query(
      'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
    );
    return row?.[0];
  } finally {
    await connection.close();
  }
};

const refusal = (url: string): Promise<unknown> =>
  connect(url).then(
    async (connection) => {
      await connection.close();
      return expect.unreachable('the connection was accepted');
    },
    (error: unknown) => error,
  );

/**
 * No reachability probe, deliberately: both variables are this suite's own, so setting them is the
 * decision to run it. A probe that answered "skip" on a failed connection skipped exactly the
 * regression this file exists for — a broken TLS path read as "no server here".
 */
const ready = base !== undefined && base !== '' && rootCert !== undefined && rootCert !== '';

/** Only a loopback server answers on 127.0.0.2 too — the address the certificate does not name. */
const loopback = ready && ['localhost', '127.0.0.1'].includes(new URL(base ?? '').hostname);

if (entityForTable(TABLE) === undefined) {
  entity(TABLE, { columns: { id: text().primaryKey(), body: text().nullable() } });
}

// File scope, so a skipped suite still unregisters what its module body registered.
afterAll(() => {
  clearRegistry();
});

describe.skipIf(!ready)('live · replication over TLS, libpq sslmode', () => {
  test('allow, prefer and require encrypt against a private CA without verifying it', async () => {
    for (const mode of ['allow', 'prefer', 'require']) {
      expect(await encrypted(urlWith(`sslmode=${mode}`))).toBe('t');
    }
  });

  test('disable stays cleartext', async () => {
    expect(await encrypted(urlWith('sslmode=disable'))).toBe('f');
  });

  test('verify-full with no trust anchor for the CA is X_REPLICATION_TLS, not a refused write', async () => {
    const error = await refusal(urlWith('sslmode=verify-full'));
    expect((error as { code?: string }).code).toBe('X_REPLICATION_TLS');
    expect((error as { fix?: string }).fix).toContain('sslrootcert=');
  });

  test('verify-full and verify-ca pass with the CA named by sslrootcert', async () => {
    const ca = `sslrootcert=${encodeURIComponent(rootCert ?? '')}`;
    expect(await encrypted(urlWith(`sslmode=verify-full&${ca}`))).toBe('t');
    expect(await encrypted(urlWith(`sslmode=verify-ca&${ca}`))).toBe('t');
  });

  test.skipIf(!loopback)(
    'a host the certificate does not name: verify-full refuses, verify-ca accepts',
    async () => {
      const ca = `sslrootcert=${encodeURIComponent(rootCert ?? '')}`;
      const error = await refusal(urlWith(`sslmode=verify-full&${ca}`, '127.0.0.2'));
      expect((error as { code?: string }).code).toBe('X_REPLICATION_TLS');
      expect((error as { cause?: string }).cause).toContain('127.0.0.2');
      expect(await encrypted(urlWith(`sslmode=verify-ca&${ca}`, '127.0.0.2'))).toBe('t');
    },
  );

  describe('a WAL stream', () => {
    let sql: PgConnection;

    beforeAll(async () => {
      sql = await connect(urlWith('sslmode=require'));
      await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
      await sql.query(
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
      );
      await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await sql.query(`CREATE TABLE ${TABLE} (id text PRIMARY KEY, body text)`);
      await sql.query(`ALTER TABLE ${TABLE} REPLICA IDENTITY FULL`);
    });

    afterAll(async () => {
      if (sql === undefined) return;
      await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
      await sql.query(
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
      );
      await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await sql.close();
    });

    // The in-band read path is the half that hung: CopyBoth over TLS, with a row several TLS
    // records long, so a message spans more than one decrypted chunk.
    test('decodes changes, including a row larger than one TLS record', async () => {
      const events: ChangeEvent[] = [];
      const feed = new PgLogicalReplicationFeed({
        url: urlWith('sslmode=require'),
        slot: SLOT,
        publication: PUBLICATION,
        entities: [TABLE],
        statusIntervalMs: 250,
      });
      await feed.start({ onChange: (event) => void events.push(event) });
      const large = 'x'.repeat(70_000);
      await sql.query(`INSERT INTO ${TABLE} VALUES ('small', 'hello'), ('large', '${large}')`);
      for (let poll = 0; poll < 200 && events.length < 2; poll += 1) await Bun.sleep(50);
      await feed.stop();

      expect(events.map((event) => event.after?.['id'])).toEqual(['small', 'large']);
      expect(events[1]?.after?.['body']).toBe(large);
    }, 30_000);
  });
});
