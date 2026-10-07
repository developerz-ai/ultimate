import { describe, expect, test } from 'bun:test';
import type { EnvSchema } from './env';
import { checkEnvExample, envFileCandidates, parseEnvKeys, renderEnvExample } from './env-example';
import * as core from './index';

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

  // An extra key ALONE keeps `ok: true`: the framework's reporter (`@ultimat3/cli`'s `app-env.ts`)
  // builds its finding from `missing` only, so `checkEnvExample` is public for an app that wants
  // `.extra` itself.
  test('an extra key alone is not drift', () => {
    const text = `${[...Object.keys(schema), 'LEGACY_KEY'].join('=\n')}=\n`;
    const report = checkEnvExample(schema, text);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual(['LEGACY_KEY']);
  });
});

// 25.0.0 deleted the second, weaker `.env.example` gate: key presence only, and nothing called it.
// The gate is `x verify`'s `manifest` step. Re-exporting either name fails here.
describe('assertEnvExample', () => {
  test('is gone from the public API, with the error class only it threw', () => {
    expect(Object.hasOwn(core, 'assertEnvExample')).toBe(false);
    expect(Object.hasOwn(core, 'EnvExampleDriftError')).toBe(false);
    expect(typeof core.checkEnvExample).toBe('function');
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
