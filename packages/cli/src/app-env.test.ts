// The `.env.example` drift gate: the four answers it can give, over real files on disk. Each
// fixture gets its own `app.config.ts` path, because `import()` caches per path and a second
// fixture reusing one would silently be asserting against the first one's declaration.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway app roots.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envExampleFindings, envExampleFor, isEnvSchema, loadEnvSchema } from './app-env';

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
    const root = await appRoot('none', 'export const config = {};\n');
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
    const root = await appRoot('fresh', SCHEMA, envExampleFor(schema ?? {}));
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
    const stale = envExampleFor(schema ?? {}).replace(
      'Postgres connection URL',
      'something else entirely',
    );
    const root = await appRoot('stale-text', SCHEMA, stale);
    const [finding] = await envExampleFindings(root);
    expect(finding?.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(finding?.cause).toContain('no longer the projection');
  });

  test('no file at all is drift, not a skip', async () => {
    const root = await appRoot('absent', SCHEMA);
    const [finding] = await envExampleFindings(root);
    expect(finding?.code).toBe('X_ENV_EXAMPLE_DRIFT');
    expect(finding?.cause).toContain('does not exist');
  });

  test('a secret never reaches the committed file, default or not', async () => {
    const schema = await loadEnvSchema(await appRoot('secret', SCHEMA));
    const rendered = envExampleFor(schema ?? {});
    expect(rendered).toContain('API_TOKEN=\n');
    expect(rendered).toContain('secret');
  });

  test('a config that will not import is reported at the config, never swallowed', async () => {
    const root = await appRoot('broken', "throw new RangeError('boom');\n");
    const [finding] = await envExampleFindings(root);
    expect(finding?.at).toBe('app.config.ts');
    expect(finding?.cause).toContain('boom');
  });
});
