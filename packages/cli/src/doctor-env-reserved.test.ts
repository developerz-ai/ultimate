import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the fixture app needs a scratch directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import {
  APP_ENV_PREFIX,
  appEnvNamesProbe,
  NO_APP_ENV_NAMES,
  reservedEnvFindings,
} from './doctor-env-reserved';
import { scaffoldEnvVarNames } from './templates/scaffold-env';

const codes = (declared: readonly string[], sealed: readonly string[] = []) =>
  reservedEnvFindings({ declared, sealed }).map((finding) => `${finding.at}:${finding.cause}`);

describe('unit · x doctor reserved env names', () => {
  test('nothing declared, nothing reported', () => {
    expect(reservedEnvFindings(NO_APP_ENV_NAMES)).toEqual([]);
  });

  // A name the framework sets for itself, sealed by the app, is overwritten or read as the harness's.
  test('a sealed framework-internal name is reported, naming the package that reads it', () => {
    const [finding] = reservedEnvFindings({ declared: [], sealed: ['TEST_DATABASE_URL'] });
    expect(finding?.code).toBe('X_ENV_NAME_RESERVED');
    expect(finding?.cause).toContain('@ultimat3/testing');
    expect(finding?.fix).toContain(`${APP_ENV_PREFIX}TEST_DATABASE_URL`);
    expect(finding?.fix.startsWith('x secrets edit')).toBe(true);
  });

  test('a switch name is reported: its presence turns a framework behaviour on', () => {
    const [finding] = reservedEnvFindings({ declared: ['OTEL_TRACES_EXPORTER'], sealed: [] });
    expect(finding?.cause).toContain('@ultimat3/core also reads OTEL_TRACES_EXPORTER');
  });

  test('a declared framework-internal name, and a name under ULTIMATE_, are reported', () => {
    expect(codes(['TEST_DATABASE_URL', 'ULTIMATE_MY_FLAG'])).toHaveLength(2);
  });

  test('the deploy contract and host names are what an app declares, and are not', () => {
    expect(codes(['DATABASE_URL', 'PORT', 'APP_URL', 'SESSION_SECRET', 'HOME', 'MY_OWN'])).toEqual(
      [],
    );
  });

  // Declared on purpose so `@ultimat3/storage`, `mail`, `cache` and `realtime` read them: the
  // rename the fix names would switch object storage, mail or the CDN purge off without a word.
  test('the adapter settings an app declares for the framework are the contract, never reported', () => {
    const names = [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'AWS_REGION',
      'RESEND_API_KEY',
      'SMTP_URL',
      'SES_ACCESS_KEY_ID',
      'CLOUDFLARE_API_TOKEN',
      'FASTLY_API_TOKEN',
      'REPLICATION_URL',
      'CHROME_PATH',
    ];
    expect(codes(names)).toEqual([]);
    expect(codes([], names)).toEqual([]);
  });

  // Its `defineEnv` block read as text: the probe reads an `envSchema` export, which it has none of.
  test("the deployed demo's declared names yield no finding, declared or sealed", async () => {
    const config = join(import.meta.dir, '..', '..', '..', 'dummy', 'social-media-clone');
    const text = await Bun.file(join(config, 'app.config.ts')).text();
    const names = [...text.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \{/gm)].map((match) => match[1] ?? '');
    expect(names).toContain('S3_BUCKET');
    expect(codes(names)).toEqual([]);
    expect(codes([], names)).toEqual([]);
  });

  // `x new`'s own declaration must never be a finding on day one.
  test('the scaffold declares no reserved name', () => {
    expect(codes(scaffoldEnvVarNames())).toEqual([]);
  });

  test('the renamed key clears the finding', () => {
    expect(codes([`${APP_ENV_PREFIX}TEST_DATABASE_URL`])).toEqual([]);
  });
});

describe('unit · the probe', () => {
  test('reads envSchema keys from app.config.ts, and no sealed names without a key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-doctor-env-'));
    try {
      await Bun.write(
        join(root, 'app.config.ts'),
        "export const envSchema = {\n  PORT: { type: 'port' },\n  ULTIMATE_SEED_TIER: { type: 'string' },\n};\n",
      );
      const fact = await appEnvNamesProbe(root, {});
      expect(fact).toMatchObject({ declared: ['PORT', 'ULTIMATE_SEED_TIER'], sealed: [] });
      const findings = reservedEnvFindings(fact);
      expect(findings.map((finding) => finding.code)).toEqual(['X_ENV_NAME_RESERVED']);
      // The edit opens at the key's own line.
      expect(findings[0]?.fix.startsWith('edit app.config.ts:3 — rename ULTIMATE_SEED_TIER')).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a config that will not import is nothing to judge, never a throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-doctor-env-'));
    try {
      await Bun.write(join(root, 'app.config.ts'), 'export const envSchema = ;\n');
      expect(await appEnvNamesProbe(root, {})).toMatchObject(NO_APP_ENV_NAMES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
