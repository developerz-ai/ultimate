// A web boot over a database still holding plaintext MFA secrets says so, with the command that
// seals them — the operator step `x doctor` only reports when someone thinks to run it.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import { applyFrameworkSchema } from './framework-schema';
import { warnUnsealedMfaSecrets } from './runtime-mfa-warning';

// Two databases, so no test needs another to have run: one never given the framework's tables, and
// one that has them, its users emptied after each test.
const bare = pgliteClient();
const client = pgliteClient();
const printWarning = logger.warn;
const warned: { message: string; fields: unknown }[] = [];

beforeAll(async () => {
  await bare.execute(raw('select 1'));
  await applyFrameworkSchema((statement) => client.execute(raw(statement)));
}, 60_000);

afterEach(async () => {
  logger.warn = printWarning;
  warned.length = 0;
  await client.execute(raw('delete from x_users'));
});

afterAll(async () => {
  await bare.close();
  await client.close();
});

const capture = (): void => {
  logger.warn = (message: string, fields?: Record<string, unknown>) => {
    warned.push({ message, fields });
  };
};

describe('unit · the boot warns about unsealed MFA secrets', () => {
  test('nothing to say before the tables exist', async () => {
    capture();
    expect(await warnUnsealedMfaSecrets(bare)).toBe(0);
    expect(warned).toEqual([]);
  });

  test('nothing to say for a database with no MFA user', async () => {
    capture();
    expect(await warnUnsealedMfaSecrets(client)).toBe(0);
    expect(warned).toEqual([]);
  });

  test('a plaintext secret is counted, coded and given the sealing command', async () => {
    await client.execute(
      raw(
        "insert into x_users (id, email, mfa_secret) values ('00000000-0000-4000-8000-000000000001', 'a@example.test', 'JBSWY3DPEHPK3PXP')",
      ),
    );
    capture();
    expect(await warnUnsealedMfaSecrets(client)).toBe(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toBe('X_MFA_SECRET_UNSEALED');
    expect(warned[0]?.fields).toMatchObject({ fix: 'x auth seal-mfa --json', unsealed: 1 });
  });
});
