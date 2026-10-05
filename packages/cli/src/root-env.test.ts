import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { RootEnvInput } from './root-env';
import { applyRootEnv, cwdFromArgv, parseDotenv, rootEnvChanges } from './root-env';

/** What the root adds — most cases here are about that half alone. */
const rootEnvAdditions = async (input: RootEnvInput): Promise<Record<string, string>> =>
  (await rootEnvChanges(input)).set;

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
    const added = await rootEnvAdditions({
      cwd: join(root, 'apps/web'),
      processCwd: join(root, 'apps/web'),
      env: { A: 'real' },
    });
    expect(added).toEqual({ B: 'local', DATABASE_URL: 'postgres://root/db' });
  });

  test('NODE_ENV picks the file set, and the cwd being the root adds nothing', async () => {
    const root = await app();
    await Bun.write(join(root, '.env.test'), 'T=1\n');
    expect(
      await rootEnvAdditions({
        cwd: join(root, 'apps/web'),
        processCwd: join(root, 'apps/web'),
        env: { NODE_ENV: 'test' },
      }),
    ).toEqual({
      A: 'base',
      B: 'base',
      T: '1',
    });
    expect(await rootEnvAdditions({ cwd: root, processCwd: root, env: {} })).toEqual({});
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

  test('`--cwd <app>` from elsewhere loads the app root, judged against the PROCESS cwd (K1)', async () => {
    const root = await app();
    const elsewhere = await mkdtemp(join(tmpdir(), 'x-root-env-elsewhere-'));
    roots.push(elsewhere);
    // `x --cwd <root>` run from an unrelated directory: Bun loaded `elsewhere`'s `.env`, not the
    // root's, so the root's files are owed even though the resolved cwd IS the root.
    expect(await rootEnvAdditions({ cwd: root, processCwd: elsewhere, env: {} })).toEqual({
      A: 'base',
      B: 'local',
      DATABASE_URL: 'postgres://root/db',
    });
    // Started IN the root: Bun loaded these itself, whatever `--cwd` says.
    expect(
      await rootEnvAdditions({ cwd: join(root, 'apps/web'), processCwd: root, env: {} }),
    ).toEqual({});
  });

  test('the local-CLI hand-over reads --cwd, both spellings', () => {
    expect(cwdFromArgv(['db', 'migrate'], '/here')).toBe('/here');
    expect(cwdFromArgv(['db', '--cwd', 'apps/x'], '/here')).toBe('/here/apps/x');
    expect(cwdFromArgv(['db', '--cwd=/abs'], '/here')).toBe('/abs');
  });
});

// The same `.env` must mean the same thing whether Bun loaded it (the process started in the root)
// or `parseDotenv` did (it started below it) — so the oracle is Bun itself, run over the same file.
describe('unit · parseDotenv agrees with Bun on the same file (K2)', () => {
  const FILE = [
    'XK2_PEM="-----BEGIN KEY-----',
    'abc',
    '   indented',
    '-----END KEY-----"',
    'XK2_BT=`back tick`',
    'XK2_BT_QUOTES=`has "dq" and \'sq\'`',
    "XK2_SQ_MULTI='one",
    "two'",
    'XK2_DQ_NL="a\\nb"',
    "XK2_SQ_NL='a\\nb'",
    'XK2_BT_NL=`a\\nb`',
    'XK2_DQ_ESC="a\\"b"',
    'XK2_DQ_BS="a\\\\nb"',
    'XK2_HASH=val#tight',
    'XK2_HASH_SP=val # loose',
    'XK2_TRAIL="x" # after',
    "XK2_SQ_HASH='a#b'",
    'XK2_MID=a"b"c',
    'XK2_PAD=  pad  ',
    'XK2_EMPTY=',
    'XK2_EMPTYQ=""',
    'export XK2_EXP=e',
    'XK2_DOLLAR=p\\$x',
    'XK2_DOLLAR_DQ="p\\$x"',
    "XK2_DOLLAR_SQ='p\\$x'",
    'XK2_DOLLAR_BT=`p\\$x`',
    'XK2_DOLLAR_PAIR="a\\\\$x"',
    'XK2_CR_DQ="a\\rb"',
    "XK2_CR_SQ='a\\rb'",
    'XK2_TAB="a\\tb"',
    'XK2_KEEP=p\\qx',
    'XK2_BARE_CR=one\rXK2_AFTER_CR=two',
    'XK2_CR_INSIDE="x\ry"',
    'XK2_OPEN="never closed',
    'XK2_AFTER=1',
    '',
  ].join('\n');

  test('multi-line quotes, backticks, escapes and comments parse exactly as Bun.env reads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-root-env-parity-'));
    roots.push(dir);
    await Bun.write(join(dir, '.env'), FILE);
    const ours = Object.fromEntries(parseDotenv(FILE));
    const keys = Object.keys(ours);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, Bun.env[k] ?? null]))))`,
      ],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { PATH: Bun.env['PATH'] ?? '' } },
    );
    const bun: unknown = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(keys).toContain('XK2_PEM');
    expect(keys).toContain('XK2_AFTER');
    expect(ours).toEqual(bun as Record<string, string>);
    expect(ours['XK2_PEM']).toBe('-----BEGIN KEY-----\nabc\n   indented\n-----END KEY-----');
  });
});

// L1: `x --cwd ../app-b db migrate` started inside app-a. Bun loaded app-a's `.env` into the
// process env before `x` ran, and a rule of "a key already set wins" let app-a's DATABASE_URL
// answer for app-b — a migration against the wrong database.
describe('unit · a key Bun loaded from ANOTHER app is not a real environment variable (L1)', () => {
  test("the target app's file wins over the starting directory's, a real variable still wins", async () => {
    const appB = await app();
    const appA = await mkdtemp(join(tmpdir(), 'x-root-env-a-'));
    roots.push(appA);
    await Bun.write(join(appA, 'app.config.ts'), 'export default {};\n');
    await Bun.write(join(appA, '.env'), 'DATABASE_URL=postgres://a/db\nONLY_A=1\n');
    // What Bun.env holds in a process started in app-a: its file, plus one real variable.
    const env = { DATABASE_URL: 'postgres://a/db', ONLY_A: '1', A: 'real' };
    const added = await rootEnvAdditions({ cwd: appB, processCwd: appA, env });
    expect(added['DATABASE_URL']).toBe('postgres://root/db');
    expect(added['A']).toBeUndefined();
    // A key only app-a declares is not app-b's to remove; it is left as it was.
    expect(added['ONLY_A']).toBeUndefined();
  });

  test('a real variable that only happens to share a key with the starting file still wins', async () => {
    const appB = await app();
    const appA = await mkdtemp(join(tmpdir(), 'x-root-env-a-'));
    roots.push(appA);
    await Bun.write(join(appA, '.env'), 'DATABASE_URL=postgres://a/db\n');
    // Bun never overrides a real variable, so a value DIFFERENT from the file's is the real one.
    const env = { DATABASE_URL: 'postgres://exported/db' };
    const added = await rootEnvAdditions({ cwd: appB, processCwd: appA, env });
    expect(added['DATABASE_URL']).toBeUndefined();
  });

  test("started below the root, the starting directory's own file still wins: it is the same app", async () => {
    const root = await app();
    await Bun.write(join(root, 'apps/web/.env'), 'DATABASE_URL=postgres://web/db\n');
    const env = { DATABASE_URL: 'postgres://web/db' };
    const web = join(root, 'apps/web');
    const added = await rootEnvAdditions({ cwd: web, processCwd: web, env });
    expect(added['DATABASE_URL']).toBeUndefined();
  });

  test("a key only the OTHER app's file set is removed, not left to answer for the target", async () => {
    // app-b relies on a default for DATABASE_URL; app-a's file names one. Kept, it migrated app-b
    // against app-a's database.
    const appB = await app();
    await Bun.write(join(appB, '.env.development'), 'B=dev\n');
    const appA = await mkdtemp(join(tmpdir(), 'x-root-env-a-'));
    roots.push(appA);
    await Bun.write(join(appA, '.env'), 'DATABASE_URL=postgres://a/db\nREAL=from-file\n');
    const env = { DATABASE_URL: 'postgres://a/db', REAL: 'exported' };
    const changes = await rootEnvChanges({ cwd: appB, processCwd: appA, env });
    expect(changes.set['DATABASE_URL']).toBeUndefined();
    expect(changes.unset).toEqual(['DATABASE_URL']);
  });

  test("another app's file-made NODE_ENV never picks the target's file set", async () => {
    // Started below app-a's root, in a directory whose `.env` sets NODE_ENV: Bun loaded it with no
    // real NODE_ENV, so it chose the default set, and so must the target's — app-b's `.env.test`
    // answering for `x --cwd ../app-b db migrate` would migrate app-b's TEST database.
    const appB = await app();
    await Bun.write(join(appB, '.env.test'), 'DATABASE_URL=postgres://test/db\n');
    const appA = await mkdtemp(join(tmpdir(), 'x-root-env-a-'));
    roots.push(appA);
    await Bun.write(join(appA, 'app.config.ts'), 'export default {};\n');
    const web = join(appA, 'apps/web');
    await Bun.write(join(web, '.env'), 'NODE_ENV=test\n');
    const changes = await rootEnvChanges({ cwd: appB, processCwd: web, env: { NODE_ENV: 'test' } });
    expect(changes.set['DATABASE_URL']).toBe('postgres://root/db');
    expect(changes.unset).toEqual(['NODE_ENV']);
  });

  test('a real NODE_ENV still picks the file set when the start directory is foreign', async () => {
    const appB = await app();
    await Bun.write(join(appB, '.env.test'), 'DATABASE_URL=postgres://test/db\n');
    const appA = await mkdtemp(join(tmpdir(), 'x-root-env-a-'));
    roots.push(appA);
    await Bun.write(join(appA, '.env'), 'NODE_ENV=development\n');
    // Differs from app-a's file, so Bun did not write it: it is the operator's, and it decides.
    const changes = await rootEnvChanges({
      cwd: appB,
      processCwd: appA,
      env: { NODE_ENV: 'test' },
    });
    expect(changes.set['DATABASE_URL']).toBe('postgres://test/db');
    expect(changes.unset).toEqual([]);
  });

  test('started inside the target root, nothing is ever removed', async () => {
    const root = await app();
    await Bun.write(join(root, 'apps/web/.env'), 'ONLY_WEB=1\n');
    const web = join(root, 'apps/web');
    const changes = await rootEnvChanges({ cwd: web, processCwd: web, env: { ONLY_WEB: '1' } });
    expect(changes.unset).toEqual([]);
  });

  test('applying the changes removes and sets, in the process env when that IS the env', () => {
    const live: Record<string, string | undefined> = { DATABASE_URL: 'postgres://a/db', KEEP: '1' };
    const changes = { set: { B: 'dev' }, unset: ['DATABASE_URL'] };
    expect(applyRootEnv(live, changes, live)).toBe(live);
    expect(live).toEqual({ KEEP: '1', B: 'dev' });
    // An injected env is never mutated: the command gets a rebuilt copy, the process env is untouched.
    const injected = { DATABASE_URL: 'postgres://a/db', KEEP: '1' };
    const process = { DATABASE_URL: 'untouched' };
    expect(applyRootEnv(injected, changes, process)).toEqual({ KEEP: '1', B: 'dev' });
    expect(injected).toEqual({ DATABASE_URL: 'postgres://a/db', KEEP: '1' });
    expect(process).toEqual({ DATABASE_URL: 'untouched' });
  });
});
