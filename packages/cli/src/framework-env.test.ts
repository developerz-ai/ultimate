// The framework's deploy-required keys: rendered into every `.env.example`, reported by
// `x env check` and `x doctor` from one list — a contract that omitted them crash-looped every
// role of a first deploy, one key at a time (#679).

import { describe, expect, test } from 'bun:test';
import { CURSOR_SECRET_FIX, parseEnvKeys, renderEnvExample } from '@ultimat3/core';
import { DEV_VAPID_KEYS } from '@ultimat3/pwa';
import { DEV_SIGNING_SECRET } from '@ultimat3/storage';
import {
  appEnvExample,
  deployed,
  FRAMEWORK_SECRETS,
  frameworkSecretFindings,
  machineSecretFindings,
  namedDeployed,
} from './framework-env';

const SCHEMA = { DATABASE_URL: { type: 'url', description: 'Postgres connection URL' } } as const;

describe('unit · the framework section of .env.example', () => {
  test('both production-required secrets are real keys in the contract, after the app’s own', () => {
    const keys = parseEnvKeys(appEnvExample(SCHEMA));
    expect(keys).toEqual(['DATABASE_URL', 'ULTIMATE_CURSOR_SECRET', 'STORAGE_SIGNING_SECRET']);
  });

  test('each says why it is needed and that it is a secret, and carries no value', () => {
    const text = appEnvExample(SCHEMA);
    expect(text).toContain('X_CURSOR_SECRET_DEV');
    expect(text).toContain('Not read when S3_ENDPOINT and S3_BUCKET select object storage.');
    expect(text).toContain('ULTIMATE_CURSOR_SECRET=\n');
    expect(text).toContain('STORAGE_SIGNING_SECRET=\n');
    expect(text.match(/required when deployed · string · secret/g)?.length).toBe(2);
  });

  test('it starts with the app’s own projection, byte for byte', () => {
    expect(appEnvExample(SCHEMA).startsWith(renderEnvExample(SCHEMA))).toBe(true);
  });

  test('a key the app declares itself is rendered once, as the app declared it', () => {
    const schema = {
      ...SCHEMA,
      ULTIMATE_CURSOR_SECRET: { type: 'string', secret: true, description: 'app-owned' },
    } as const;
    const keys = parseEnvKeys(appEnvExample(schema));
    expect(keys.filter((key) => key === 'ULTIMATE_CURSOR_SECRET')).toHaveLength(1);
    expect(appEnvExample(schema)).toContain('# app-owned');
  });

  test('an app declaring every framework key gets no framework section at all', () => {
    const schema = {
      ULTIMATE_CURSOR_SECRET: { type: 'string', secret: true },
      STORAGE_SIGNING_SECRET: { type: 'string', secret: true },
    } as const;
    expect(appEnvExample(schema)).toBe(renderEnvExample(schema));
  });
});

describe('unit · what a deployed process would refuse', () => {
  const REAL = 'a'.repeat(64);

  test('an empty table owes both keys, each under its diagnostic code', () => {
    expect(frameworkSecretFindings({}).map((finding) => finding.code)).toEqual([
      'X_CURSOR_SECRET_DEV',
      'X_STORAGE_SECRET_DEV',
    ]);
  });

  test('an empty value is unset — a blank chart value signs with nothing', () => {
    const codes = frameworkSecretFindings({
      ULTIMATE_CURSOR_SECRET: '',
      STORAGE_SIGNING_SECRET: '',
    });
    expect(codes.map((finding) => finding.code)).toEqual([
      'X_CURSOR_SECRET_DEV',
      'X_STORAGE_SECRET_DEV',
    ]);
  });

  test('the published cursor key counts as no secret, exactly as the boot reads it', () => {
    const findings = frameworkSecretFindings({
      ULTIMATE_CURSOR_SECRET: 'ultimate-dev-cursor-secret',
      STORAGE_SIGNING_SECRET: REAL,
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_CURSOR_SECRET_DEV']);
  });

  test('the published storage literal counts as no secret', () => {
    const findings = frameworkSecretFindings({
      ULTIMATE_CURSOR_SECRET: REAL,
      STORAGE_SIGNING_SECRET: DEV_SIGNING_SECRET,
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_STORAGE_SECRET_DEV']);
  });

  test('object storage needs no disk secret: S3_ENDPOINT is the selection the boot makes', () => {
    const findings = frameworkSecretFindings({
      ULTIMATE_CURSOR_SECRET: REAL,
      S3_ENDPOINT: 'https://s3.example.com',
    });
    expect(findings).toEqual([]);
    expect(
      frameworkSecretFindings({ ULTIMATE_CURSOR_SECRET: REAL, S3_ENDPOINT: ' ' }).map(
        (finding) => finding.code,
      ),
    ).toEqual(['X_STORAGE_SECRET_DEV']);
  });

  // The boot's rule, failing closed: no named environment is production. Development and test
  // owe nothing; staging owes what production owes (#679 review).
  test('the gate is the boot’s own: deployed unless development or test', () => {
    expect(deployed({})).toBe(true);
    expect(deployed({ ULTIMATE_ENV: 'staging' })).toBe(true);
    expect(deployed({ NODE_ENV: 'test' })).toBe(false);
    expect(frameworkSecretFindings({ ULTIMATE_ENV: 'development' })).toEqual([]);
    expect(frameworkSecretFindings({ ULTIMATE_ENV: 'staging' })).toHaveLength(2);
  });

  // Two questions, two gates over one list: env check is the boot (fails closed), doctor is this
  // machine as it names itself. They agree everywhere an environment is NAMED.
  test('doctor’s gate needs a named deploy; env check’s does not', () => {
    expect(namedDeployed({})).toBe(false);
    expect(machineSecretFindings({})).toEqual([]);
    expect(frameworkSecretFindings({})).toHaveLength(2);
    for (const named of ['staging', 'production']) {
      expect(namedDeployed({ ULTIMATE_ENV: named })).toBe(true);
      expect(machineSecretFindings({ ULTIMATE_ENV: named })).toEqual(
        frameworkSecretFindings({ ULTIMATE_ENV: named }),
      );
    }
    expect(namedDeployed({ ULTIMATE_ENV: 'prodcution' })).toBe(false);
    expect(namedDeployed({ NODE_ENV: 'test' })).toBe(false);
  });

  test('the cursor fix is the boot refusal’s own line', () => {
    expect(FRAMEWORK_SECRETS[0]?.fix).toBe(CURSOR_SECRET_FIX);
  });

  test('real secrets owe nothing', () => {
    expect(
      frameworkSecretFindings({ ULTIMATE_CURSOR_SECRET: REAL, STORAGE_SIGNING_SECRET: REAL }),
    ).toEqual([]);
  });

  test('every fix is a literal command that mints the key it names', () => {
    for (const secret of FRAMEWORK_SECRETS) {
      // A key PAIR is not 32 random bytes: one command mints and seals both halves together.
      const fix =
        secret.code === 'X_PWA_VAPID_KEY_MISSING'
          ? 'x vapid create'
          : `export ${secret.key}="$(openssl rand -hex 32)"`;
      expect(secret.fix).toBe(fix);
    }
  });
});

describe('unit · the VAPID pair, owed once pwa.push is on', () => {
  const PUSH = { push: true } as const;

  test('push off: neither key is in the contract or a finding — a key with no reader is noise', () => {
    expect(parseEnvKeys(appEnvExample(SCHEMA))).not.toContain('ULTIMATE_VAPID_PRIVATE_KEY');
    expect(frameworkSecretFindings({}).map((finding) => finding.code)).not.toContain(
      'X_PWA_VAPID_KEY_MISSING',
    );
  });

  test('push on: both halves render after the framework secrets, the public one not as a secret', () => {
    const text = appEnvExample(SCHEMA, PUSH);
    expect(parseEnvKeys(text)).toEqual([
      'DATABASE_URL',
      'ULTIMATE_CURSOR_SECRET',
      'STORAGE_SIGNING_SECRET',
      'ULTIMATE_VAPID_PUBLIC_KEY',
      'ULTIMATE_VAPID_PRIVATE_KEY',
    ]);
    expect(text).toContain('# required when deployed · string\nULTIMATE_VAPID_PUBLIC_KEY=\n');
    expect(text).toContain(
      '# required when deployed · string · secret\nULTIMATE_VAPID_PRIVATE_KEY=\n',
    );
    expect(text).toContain('x vapid create');
  });

  test('a deployed table with push on owes both — and the published development key counts as none', () => {
    const owed = (env: Record<string, string>) =>
      frameworkSecretFindings(env, new Set(), PUSH)
        .filter((finding) => finding.code === 'X_PWA_VAPID_KEY_MISSING')
        .map((finding) => finding.cause.split(' ')[0]);
    expect(owed({})).toEqual(['ULTIMATE_VAPID_PUBLIC_KEY', 'ULTIMATE_VAPID_PRIVATE_KEY']);
    expect(
      owed({
        ULTIMATE_VAPID_PUBLIC_KEY: DEV_VAPID_KEYS.publicKey,
        ULTIMATE_VAPID_PRIVATE_KEY: DEV_VAPID_KEYS.privateKey,
      }),
    ).toEqual(['ULTIMATE_VAPID_PRIVATE_KEY']);
    expect(
      owed({ ULTIMATE_VAPID_PUBLIC_KEY: 'B-real', ULTIMATE_VAPID_PRIVATE_KEY: 'real-private' }),
    ).toEqual([]);
    expect(frameworkSecretFindings({ ULTIMATE_ENV: 'development' }, new Set(), PUSH)).toEqual([]);
  });
});
