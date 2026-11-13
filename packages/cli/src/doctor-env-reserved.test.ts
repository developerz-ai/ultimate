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

  // The adopter case: an app's own Cloudflare token was read by the CDN purge.
  test('a sealed switch name is reported, naming the package that reads it', () => {
    const [finding] = reservedEnvFindings({ declared: [], sealed: ['CLOUDFLARE_API_TOKEN'] });
    expect(finding?.code).toBe('X_ENV_NAME_RESERVED');
    expect(finding?.cause).toContain('@ultimat3/cache');
    expect(finding?.fix).toContain(`${APP_ENV_PREFIX}CLOUDFLARE_API_TOKEN`);
    expect(finding?.fix.startsWith('x secrets edit')).toBe(true);
  });

  test('a declared framework-internal name, and a name under ULTIMATE_, are reported', () => {
    expect(codes(['TEST_DATABASE_URL', 'ULTIMATE_MY_FLAG'])).toHaveLength(2);
  });

  test('the deploy contract and host names are what an app declares, and are not', () => {
    expect(codes(['DATABASE_URL', 'PORT', 'APP_URL', 'SESSION_SECRET', 'HOME', 'MY_OWN'])).toEqual(
      [],
    );
  });

  // `x new`'s own declaration must never be a finding on day one.
  test('the scaffold declares no reserved name', () => {
    expect(codes(scaffoldEnvVarNames())).toEqual([]);
  });

  test('the renamed key clears the finding', () => {
    expect(codes([`${APP_ENV_PREFIX}CLOUDFLARE_API_TOKEN`])).toEqual([]);
  });
});

describe('unit · the probe', () => {
  test('reads envSchema keys from app.config.ts, and no sealed names without a key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-doctor-env-'));
    try {
      await Bun.write(
        join(root, 'app.config.ts'),
        "export const envSchema = {\n  PORT: { type: 'port' },\n  FASTLY_API_TOKEN: { type: 'string' },\n};\n",
      );
      const fact = await appEnvNamesProbe(root, {});
      expect(fact).toMatchObject({ declared: ['PORT', 'FASTLY_API_TOKEN'], sealed: [] });
      const findings = reservedEnvFindings(fact);
      expect(findings.map((finding) => finding.code)).toEqual(['X_ENV_NAME_RESERVED']);
      // The edit opens at the key's own line.
      expect(findings[0]?.fix.startsWith('edit app.config.ts:3 — rename FASTLY_API_TOKEN')).toBe(
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
