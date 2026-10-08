// The `.env.example` drift gate: the four answers it can give, over real files on disk. Each
// fixture gets its own `app.config.ts` path, because `import()` caches per path and a second
// fixture reusing one would silently be asserting against the first one's declaration.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway app
// roots.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { parseEnvKeys, renderEnvExample } from '@ultimat3/core';
import { envExampleFindings, envExampleFor, isEnvSchema, loadEnvSchema } from './app-env';
import { NO_APP_FACTS } from './framework-env';

const SCHEMA = `export const envSchema = {
  DATABASE_URL: { type: 'url', description: 'Postgres connection URL' },
  API_TOKEN: { type: 'string', secret: true, required: false, description: 'Upstream token' },
};
export const config = { name: 'fixture' };
`;

let base = '';

/** One app root per case: same reason two fixtures never share an `app.config.ts` path. */
const appRoot = async (name: string, config: string, example?: string): Promise<string> => {
  const dir = join(base, name);
  await Bun.write(join(dir, 'app.config.ts'), config);
  if (example !== undefined) await Bun.write(join(dir, '.env.example'), example);
  return dir;
};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'x-app-env-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('unit · reading the app env declaration', () => {
  test('it reads the schema back out of app.config.ts', async () => {
    const schema = await loadEnvSchema(await appRoot('read', SCHEMA));
    expect(Object.keys(schema ?? {})).toEqual(['DATABASE_URL', 'API_TOKEN']);
  });

  test('an app that declares no environment declares nothing to drift', async () => {
    const root = await appRoot('none', "export const config = { name: 'fixture' };\n");
    expect(await loadEnvSchema(root)).toBeUndefined();
    expect(await envExampleFindings(root)).toEqual([]);
  });

  test('a value that is not a schema is not treated as one', () => {
    expect(isEnvSchema({ A: { type: 'url' } })).toBe(true);
    expect(isEnvSchema({ A: { type: 'not-a-type' } })).toBe(false);
    expect(isEnvSchema({ A: 'url' })).toBe(false);
    expect(isEnvSchema(null)).toBe(false);
  });
});

describe('unit · the .env.example drift gate', () => {
  test('the projection and the committed file agreeing is silence', async () => {
    const schema = await loadEnvSchema(await appRoot('fresh', SCHEMA));
    const root = await appRoot('fresh', SCHEMA, envExampleFor(schema ?? {}, NO_APP_FACTS));
    expect(await envExampleFindings(root)).toEqual([]);
  });

  test('a declared key the file never got names the key and hands back the generator', async () => {
    const root = await appRoot('missing-key', SCHEMA, '# stale\nDATABASE_URL=\n');
    const [finding] = await envExampleFindings(root);
    expect(finding?.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(finding?.cause).toContain('API_TOKEN');
    expect(finding?.fix).toBe('x env example');
    expect(finding?.at).toBe('.env.example');
  });

  // The half a key-only rule would miss. The example carries each variable's description, whether
  // it is required and its default; all three can rot while every key is still present.
  test('a description that moved is drift even though no key is missing', async () => {
    const schema = await loadEnvSchema(await appRoot('stale-text', SCHEMA));
    const stale = envExampleFor(schema ?? {}, NO_APP_FACTS).replace(
      'Postgres connection URL',
      'something else entirely',
    );
    const root = await appRoot('stale-text', SCHEMA, stale);
    const [finding] = await envExampleFindings(root);
    expect(finding?.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(finding?.cause).toContain('no longer the projection');
  });

  // #679: a 24.x example is the app's projection alone. The framework's deploy-required keys are
  // part of the contract now, and the finding names them rather than "a description moved".
  test('an example missing the framework keys names them', async () => {
    const schema = await loadEnvSchema(await appRoot('framework-keys', SCHEMA));
    const root = await appRoot('framework-keys', SCHEMA, renderEnvExample(schema ?? {}));
    const [finding] = await envExampleFindings(root);
    expect(finding?.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(finding?.cause).toContain('ULTIMATE_CURSOR_SECRET, STORAGE_SIGNING_SECRET');
    expect(finding?.cause).toContain('the framework');
  });

  test('the projection carries the framework keys after the app’s', async () => {
    const schema = await loadEnvSchema(await appRoot('framework-render', SCHEMA));
    expect(parseEnvKeys(envExampleFor(schema ?? {}, NO_APP_FACTS))).toEqual([
      'DATABASE_URL',
      'API_TOKEN',
      'ULTIMATE_CURSOR_SECRET',
      'STORAGE_SIGNING_SECRET',
    ]);
  });

  test('no file at all is drift, not a skip', async () => {
    const root = await appRoot('absent', SCHEMA);
    const [finding] = await envExampleFindings(root);
    expect(finding?.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(finding?.cause).toContain('does not exist');
  });

  test('a secret never reaches the committed file, default or not', async () => {
    const schema = await loadEnvSchema(await appRoot('secret', SCHEMA));
    const rendered = envExampleFor(schema ?? {}, NO_APP_FACTS);
    expect(rendered).toContain('API_TOKEN=\n');
    expect(rendered).toContain('secret');
  });

  /** `pwa.push` on: the app owes the VAPID pair, which the example must carry. */
  const pushConfig = (vapid: string) => `export const envSchema = {
  DATABASE_URL: { type: 'url', description: 'Postgres connection URL' },
};
export const config = {
  name: 'fixture',
  pwa: {
    enabled: true,
    name: 'Fixture',
    colors: {
      light: { themeColor: '#111111', backgroundColor: '#ffffff' },
      dark: { themeColor: '#eeeeee', backgroundColor: '#000000' },
    },
    offline: { fallback: '/offline' },
    push: true,${vapid}
  },
};
`;

  test('a push app owes the VAPID pair: read off app.config.ts, named when the example lacks it', async () => {
    const config = pushConfig(" vapid: { subject: 'mailto:ops@example.com' },");
    const schema = await loadEnvSchema(await appRoot('push-owed', config));
    const stale = await appRoot('push-owed', config, envExampleFor(schema ?? {}, NO_APP_FACTS));
    const [finding] = await envExampleFindings(stale);
    expect(finding?.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(finding?.cause).toContain('ULTIMATE_VAPID_PUBLIC_KEY, ULTIMATE_VAPID_PRIVATE_KEY');
    const current = await appRoot(
      'push-current',
      config,
      envExampleFor(schema ?? {}, { push: true }),
    );
    expect(await envExampleFindings(current)).toEqual([]);
    // The header names each key's own generator: `openssl` cannot mint a P-256 pair.
    expect(envExampleFor(schema ?? {}, { push: true })).toContain('`x vapid create`');
  });

  test('a config defineConfig refuses is a finding at the config, never a crash of the step', async () => {
    const root = await appRoot(
      'push-bad-subject',
      pushConfig(" vapid: { subject: 'ops@example.com' },"),
      '',
    );
    const [finding] = await envExampleFindings(root);
    expect(finding?.code).toBe('X_CONFIG_INVALID');
    expect(finding?.at).toBe('app.config.ts');
  });

  test('a config that will not import is reported at the config, never swallowed', async () => {
    const root = await appRoot('broken', "throw new RangeError('boom');\n");
    const [finding] = await envExampleFindings(root);
    expect(finding?.at).toBe('app.config.ts');
    expect(finding?.cause).toContain('boom');
  });
});
