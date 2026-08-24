import { describe, expect, test } from 'bun:test';
import type { EnvSchema } from './env';
import {
  assertEnvExample,
  checkEnvExample,
  envFileCandidates,
  parseEnvKeys,
  renderEnvExample,
} from './env-example';
import { isUltimateError, type UltimateError } from './errors';

const schema = {
  DATABASE_URL: { type: 'url', secret: true, description: 'Postgres connection string' },
  PORT: { type: 'port', default: 3000 },
  ULTIMATE_ENV: { type: 'enum', values: ['development', 'staging', 'production'] },
  NATS_URL: { type: 'url', role: 'sync', required: false },
} as const satisfies EnvSchema;

describe('renderEnvExample', () => {
  test('projects the schema, and never a secret value', () => {
    const text = renderEnvExample(schema);
    expect(text).toContain('# Postgres connection string');
    expect(text).toContain('# required · url · secret');
    expect(text).toContain('DATABASE_URL=\n');
    expect(text).toContain('PORT=3000');
    expect(text).toContain('ULTIMATE_ENV=development');
    expect(text).toContain('# optional · url · role sync');
    expect(text.endsWith('\n')).toBe(true);
  });

  test('is deterministic, so regenerating diffs to nothing', () => {
    expect(renderEnvExample(schema)).toBe(renderEnvExample(schema));
  });

  test('round-trips: what it renders is what the drift check reads back', () => {
    expect(checkEnvExample(schema, renderEnvExample(schema))).toEqual({
      ok: true,
      missing: [],
      extra: [],
    });
  });
});

describe('parseEnvKeys', () => {
  test('reads keys, ignores comments, blanks and values', () => {
    expect(
      parseEnvKeys('# a comment\n\nA=1\nexport B="two"\n  C = 3\n=nokey\nD\n9BAD=x\n'),
    ).toEqual(['A', 'B', 'C']);
  });
});

describe('checkEnvExample', () => {
  test('a declared key with no line is drift; an undeclared line is not', () => {
    const report = checkEnvExample(schema, 'DATABASE_URL=\nPORT=3000\nROLE=web\n');
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['ULTIMATE_ENV', 'NATS_URL']);
    expect(report.extra).toEqual(['ROLE']);
  });

  // The half the comment on `EnvExampleReport.extra` used to overstate. An extra key ALONE keeps
  // `ok: true`, so `assertEnvExample` returns before it builds an error and the list reaches no
  // surface at all — it rides out only on `meta` of a drift raised by a MISSING key, i.e. only when
  // something else already failed. `checkEnvExample` is public, so an app reading `.extra` itself
  // is the one reader there is; the framework's own reporter (`@ultimat3/cli`'s `app-env.ts`)
  // builds its finding from `missing` only.
  test('an extra key alone is not drift, and nothing raises it', () => {
    const text = `${[...Object.keys(schema), 'LEGACY_KEY'].join('=\n')}=\n`;
    const report = checkEnvExample(schema, text);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual(['LEGACY_KEY']);
    // Silent: the value is computed and there is no path that reports it on its own.
    expect(() => {
      assertEnvExample(schema, text);
    }).not.toThrow();
  });

  test('assertEnvExample throws X_ENV_EXAMPLE_DRIFT naming the keys and the rewrite', () => {
    let caught: unknown;
    try {
      assertEnvExample(schema, 'PORT=3000\n');
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(error.cause).toContain('DATABASE_URL');
    expect(error.fix).toContain("Bun.write('.env.example', renderEnvExample(schema))");
    expect(assertEnvExample(schema, renderEnvExample(schema))).toBeUndefined();
  });
});

describe('envFileCandidates', () => {
  // Measured against Bun 1.4: the mode is production/test or development, never `staging`.
  test('matches what Bun actually loads, lowest precedence first', () => {
    expect(envFileCandidates('production')).toEqual(['.env', '.env.production', '.env.local']);
    expect(envFileCandidates('test')).toEqual(['.env', '.env.test']);
    expect(envFileCandidates(undefined)).toEqual(['.env', '.env.development', '.env.local']);
    // The trap this encodes: NODE_ENV=staging still reads .env.development.
    expect(envFileCandidates('staging')).toEqual(['.env', '.env.development', '.env.local']);
  });
});
