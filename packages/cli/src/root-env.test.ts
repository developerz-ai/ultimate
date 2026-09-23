import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { cwdFromArgv, parseDotenv, rootEnvAdditions } from './root-env';

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

const app = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'x-root-env-'));
  roots.push(dir);
  await Bun.write(join(dir, 'app.config.ts'), 'export default {};\n');
  await Bun.write(join(dir, 'apps/web/page.ts'), '');
  await Bun.write(join(dir, '.env'), 'A=base\nB=base\n');
  await Bun.write(join(dir, '.env.development'), 'DATABASE_URL=postgres://root/db\nB=dev\n');
  await Bun.write(join(dir, '.env.development.local'), 'B=local\n');
  return dir;
};

describe('unit · a command run from apps/web reads the ROOT .env files (row f)', () => {
  test('the root files load in Bun precedence, and a real variable is never overridden', async () => {
    const root = await app();
    const added = await rootEnvAdditions(join(root, 'apps/web'), { A: 'real' });
    expect(added).toEqual({ B: 'local', DATABASE_URL: 'postgres://root/db' });
  });

  test('NODE_ENV picks the file set, and the cwd being the root adds nothing', async () => {
    const root = await app();
    await Bun.write(join(root, '.env.test'), 'T=1\n');
    expect(await rootEnvAdditions(join(root, 'apps/web'), { NODE_ENV: 'test' })).toEqual({
      A: 'base',
      B: 'base',
      T: '1',
    });
    expect(await rootEnvAdditions(root, {})).toEqual({});
  });

  test('dotenv lines: export, quotes, comments', () => {
    const parsed = parseDotenv(
      '# c\nexport A=1\nB="two words"\nC=\'x # y\'\nD=bare # note\nE="a\\nb"\nnot a line\n',
    );
    expect(Object.fromEntries(parsed)).toEqual({
      A: '1',
      B: 'two words',
      C: 'x # y',
      D: 'bare',
      E: 'a\nb',
    });
  });

  test('the local-CLI hand-over reads --cwd, both spellings', () => {
    expect(cwdFromArgv(['db', 'migrate'], '/here')).toBe('/here');
    expect(cwdFromArgv(['db', '--cwd', 'apps/x'], '/here')).toBe('/here/apps/x');
    expect(cwdFromArgv(['db', '--cwd=/abs'], '/here')).toBe('/abs');
  });
});
