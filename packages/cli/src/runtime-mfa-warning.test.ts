// A web boot over a database still holding plaintext MFA secrets says so, with the command that
// seals them — the operator step `x doctor` only reports when someone thinks to run it.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { createPgliteClient, raw } from '@ultimat3/db';
import { applyFrameworkSchema } from './framework-schema';
import { warnUnsealedMfaSecrets } from './runtime-mfa-warning';

const client = createPgliteClient();
const printWarning = logger.warn;
const warned: { message: string; fields: unknown }[] = [];

afterEach(() => {
  logger.warn = printWarning;
  warned.length = 0;
});

afterAll(async () => {
  await client.close();
});

const capture = (): void => {
  logger.warn = (message: string, fields?: Record<string, unknown>) => {
    warned.push({ message, fields });
  };
};

describe('unit · the boot warns about unsealed MFA secrets', () => {
  test('nothing to say before the tables exist, and nothing for a database with no MFA user', async () => {
    capture();
    expect(await warnUnsealedMfaSecrets(client)).toBe(0);
    await applyFrameworkSchema((statement) => client.execute(raw(statement)));
    expect(await warnUnsealedMfaSecrets(client)).toBe(0);
    expect(warned).toEqual([]);
  }, 60_000);

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
