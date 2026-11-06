// `x doctor` on a `database.rowSecurity` app, against the test services: connected as the
// superuser `ultimate` it names the exemption; connected as a bound role it says nothing; with the
// flag off it never connects. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { postgresClient, raw } from '@ultimat3/db';
import { rowSecurityProbe } from './doctor-row-security';

const url = Bun.env['TEST_DATABASE_URL'] ?? '';
const ROLE = 'x_doctor_rls_probe';
const env = { ROLE: 'web' };

async function app(rowSecurity: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-doctor-rls-'));
  await Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { name: 'rls-app', database: { rowSecurity: ${String(rowSecurity)} } };\n`,
  );
  return root;
}

describe.skipIf(url === '')('live · x doctor · row security', () => {
  const roots: string[] = [];
  beforeAll(async () => {
    const admin = postgresClient({ url, role: 'migrate', profile: { max: 1 } });
    await admin.execute(raw(`drop role if exists ${ROLE}`));
    await admin.execute(
      raw(`create role ${ROLE} login password '${ROLE}' nosuperuser nobypassrls`),
    );
    await admin.close();
  });
  afterAll(async () => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    const admin = postgresClient({ url, role: 'migrate', profile: { max: 1 } });
    await admin.execute(raw(`drop role if exists ${ROLE}`));
    await admin.close();
  });

  test('the superuser is named; a bound role is not; off never asks', async () => {
    const on = await app(true);
    const off = await app(false);
    roots.push(on, off);
    const [finding] = await rowSecurityProbe(on, url, env);
    expect(finding?.code).toBe('X_DB_ROW_SECURITY_BYPASSED');
    const bound = new URL(url);
    bound.username = ROLE;
    bound.password = ROLE;
    expect(await rowSecurityProbe(on, bound.toString(), env)).toEqual([]);
    expect(await rowSecurityProbe(off, url, env)).toEqual([]);
  });
});
