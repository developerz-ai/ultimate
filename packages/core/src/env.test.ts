import { describe, expect, test } from 'bun:test';
import { checkEnv, defineEnv, describeEnv, type EnvSchema } from './env';
import { isUltimateError, type UltimateError } from './errors';

const schema = {
  DATABASE_URL: { type: 'url', secret: true },
  PORT: { type: 'port', default: 3000 },
  LOG_JSON: { type: 'boolean', default: true },
  STAGE: { type: 'enum', values: ['dev', 'staging', 'prod'] },
  SENTRY_DSN: { type: 'url', required: false },
  NATS_URL: { type: 'url', role: 'sync' },
} as const satisfies EnvSchema;

describe('defineEnv', () => {
  test('reports every missing and invalid key in one error', () => {
    let caught: unknown;
    try {
      defineEnv(schema, { env: { PORT: 'not-a-port', STAGE: 'qa', ROLE: 'web' } });
    } catch (thrown) {
      caught = thrown;
    }

    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_ENV_MISSING');
    // Three problems, one throw — no restart-and-discover loop.
    expect(error.cause).toContain('DATABASE_URL is missing');
    expect(error.cause).toContain('PORT="not-a-port" is not an integer port 1-65535');
    expect(error.cause).toContain('STAGE="qa" is not one of dev | staging | prod');
    expect(error.fix).toBe(
      'add DATABASE_URL PORT STAGE to .env (copy .env.example), then run: x env check',
    );
  });

  test('coerces types, applies defaults and skips role-scoped keys', () => {
    const env = defineEnv(schema, {
      env: {
        DATABASE_URL: 'postgres://localhost:5432/app',
        STAGE: 'prod',
        LOG_JSON: 'off',
        ROLE: 'web',
      },
    });

    expect(env.PORT).toBe(3000);
    expect(env.LOG_JSON).toBe(false);
    expect(env.STAGE).toBe('prod');
    expect(env.SENTRY_DSN).toBeUndefined();
    // NATS_URL is only required for role=sync.
    expect(env.NATS_URL).toBeUndefined();
    expect(Object.isFrozen(env)).toBe(true);
  });

  test('a role-scoped key becomes required for that role', () => {
    const report = checkEnv(schema, {
      env: { DATABASE_URL: 'postgres://x/y', STAGE: 'dev', ROLE: 'sync' },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.key)).toEqual(['NATS_URL']);
  });

  test('masks secret values in issues and never leaks them', () => {
    const report = checkEnv(schema, { env: { DATABASE_URL: 'not a url', STAGE: 'dev' } });
    const issue = report.issues.find((candidate) => candidate.key === 'DATABASE_URL');
    expect(issue?.received).toBe('***');
  });

  test('describeEnv emits declarations only, safe for x.manifest.json', () => {
    const summary = describeEnv(schema);
    expect(summary.find((entry) => entry.key === 'DATABASE_URL')).toEqual({
      key: 'DATABASE_URL',
      type: 'url',
      required: true,
      secret: true,
      hasDefault: false,
      roles: 'all',
      description: undefined,
    });
    expect(summary.find((entry) => entry.key === 'NATS_URL')?.roles).toEqual(['sync']);
  });

  test('is fast enough to run at boot', () => {
    const started = performance.now();
    for (let index = 0; index < 200; index += 1) {
      checkEnv(schema, { env: { DATABASE_URL: 'postgres://x/y', STAGE: 'dev', ROLE: 'web' } });
    }
    expect(performance.now() - started).toBeLessThan(40);
  });
});
