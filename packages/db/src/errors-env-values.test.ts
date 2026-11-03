// Single responsibility: a refused environment value never travels in the error. An operator who
// pastes a connection string into the wrong variable would otherwise see the password in the boot log
// and in every `--json` payload, `meta` included. Shape only, the rule `connection-url.ts` follows.

import { describe, expect, test } from 'bun:test';
import { type DbError, poolMaxInvalid } from './errors';
import { poolerFromEnv } from './pooler';

const PASTED = 'postgres://u:S3CRET@h/x';

/** `DATABASE_POOLER`'s refusal is private to `pooler.ts`: reached the way a boot reaches it. */
const refusePooler = (raw: string): DbError => {
  try {
    poolerFromEnv({ DATABASE_POOLER: raw });
  } catch (error) {
    return error as DbError;
  }
  return expect.unreachable('DATABASE_POOLER accepted a connection string');
};

describe('a refused environment value is described, never echoed', () => {
  for (const [name, refuse] of [
    ['DATABASE_POOL_MAX', poolMaxInvalid],
    ['DATABASE_POOLER', refusePooler],
  ] as const) {
    test(`${name}: the cause, the fix and the JSON carry no part of it`, () => {
      const error = refuse(PASTED);

      expect(error.code).toBe('X_ENV_MISSING');
      expect(error.cause).toContain(name);
      expect(error.cause).toContain('a string of 23 characters');
      const everything = JSON.stringify(error.toJSON());
      expect(everything).not.toContain('S3CRET');
      expect(everything).not.toContain('postgres://');
    });
  }
});
