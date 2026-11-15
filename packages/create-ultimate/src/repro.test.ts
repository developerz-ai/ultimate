// `create-ultimate repro <bundle.json>`: the scratch app it writes — a reproducer REBUILT from the
// bundle's subject (its own `reproducer` text is a stranger's and never reaches disk), importing the
// scratch app's db package, the bundle beside it, every `@ultimat3/*` linked to a framework
// checkout — what it refuses to open, and that every line it prints renders.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no synchronous existence check.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join, resolve } from 'node:path';
import { createApp } from './index';

const parent = mkdtempSync(join(tmpdir(), 'create-ultimate-repro-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const CHECKOUT = resolve(import.meta.dir, '..', '..', '..');

/** What a stranger could put in an attachment: code, and a path that climbs out. */
const HOSTILE = "import { $ } from 'bun'; await $`touch /tmp/PWNED`;";

const SUBJECT = {
  id: 'bundle-1',
  fingerprint: 'fp-1',
  code: 'X_PLANTED',
  operation: null,
  primitive: 'action',
  name: 'createPost',
  at: 0,
  requestId: 'req-1',
  traceId: null,
  build: null,
  input: { title: '[redacted]' },
  masked: ['title'],
  actor: null,
  flags: {},
  reads: [],
  truncated: false,
};

const BUNDLE = {
  format: 'x-repro-bundle/1',
  id: 'req-1',
  code: 'X_PLANTED',
  framework: { packages: { '@ultimat3/core': ['31.27.0'] } },
  subject: SUBJECT,
  reproducer: { file: 'repro/../../evil.test.ts', source: [HOSTILE] },
};

const fileWith = async (name: string, value: unknown): Promise<string> => {
  const path = join(parent, name);
  await Bun.write(path, JSON.stringify(value));
  return path;
};

const run = async (argv: readonly string[]): Promise<{ code: number; out: string }> => {
  const lines: string[] = [];
  const code = await createApp({ argv, cwd: parent, write: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
};

const codeOf = (out: string): string | undefined =>
  (JSON.parse(out) as { findings?: { code: string }[] }).findings?.[0]?.code;

/** Every file under `dir`, relative, so a test can say what was and was not written. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
    (path) => !path.includes('node_modules'),
  );

describe('create-ultimate repro', () => {
  test('a bundle opens with a reproducer rebuilt from its subject; its own source never lands', async () => {
    const path = await fileWith('bundle.json', BUNDLE);
    const { code, out } = await run(['repro', path, '--framework', CHECKOUT, '--json']);
    expect(code).toBe(0);
    const dir = join(parent, 'repro-req1');
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      data: { dir, framework: CHECKOUT, file: 'repro/repro-req1.contract.test.ts' },
    });
    const test = await Bun.file(join(dir, 'repro/repro-req1.contract.test.ts')).text();
    expect(test).toContain("import { driver } from '@repro-req1/db';");
    expect(test).toContain('const outcome = await reproduce(BUNDLE, { driver });');
    for (const file of filesUnder(dir).filter((name) => name.endsWith('.ts'))) {
      expect(await Bun.file(join(dir, file)).text()).not.toContain('PWNED');
    }
    expect(existsSync(join(parent, 'evil.test.ts'))).toBe(false);
    const pkg = (await Bun.file(join(dir, 'package.json')).json()) as {
      overrides: Record<string, string>;
    };
    expect(pkg.overrides['@ultimat3/core']).toBe(`file:${join(CHECKOUT, 'packages', 'core')}`);
  });

  test('every line it prints is a rendered message, never a ⟦key⟧', async () => {
    const path = await fileWith('render.json', {
      ...BUNDLE,
      subject: { ...SUBJECT, requestId: 'req-render' },
    });
    const { code, out } = await run(['repro', path]);
    expect(code).toBe(0);
    expect(out).not.toContain('⟦');
    expect(out).toContain('opened X_PLANTED');
  });

  test('a second open into the same directory is refused, nothing overwritten', async () => {
    const path = await fileWith('bundle.json', BUNDLE);
    const { code, out } = await run(['repro', path, '--framework', CHECKOUT, '--json']);
    expect(code).toBe(1);
    expect(codeOf(out)).toBe('X_CLI_BAD_FLAG');
  });

  test.each([
    ['no bundle at all', { hello: 'world' }],
    ['another format', { ...BUNDLE, format: 'x-repro-bundle/0' }],
    ['no subject, only a reproducer', { ...BUNDLE, subject: undefined }],
    ['a subject missing a field', { ...BUNDLE, subject: { ...SUBJECT, reads: undefined } }],
    ['a terminal escape in the name', { ...BUNDLE, subject: { ...SUBJECT, name: 'a\u001b[2Jb' } }],
  ])('%s is X_REPRO_BUNDLE_INVALID and writes nothing', async (why, value) => {
    const name = `${why.replaceAll(' ', '-')}.json`;
    const before = filesUnder(parent).length;
    const { code, out } = await run(['repro', await fileWith(name, value), '--json']);
    expect(code).toBe(1);
    expect(codeOf(out)).toBe('X_REPRO_BUNDLE_INVALID');
    expect(filesUnder(parent).length).toBe(before + 1);
  });

  test('a job failure opens under its job id, with a job reproducer', async () => {
    const failure = {
      jobId: '00000000-0000-4000-8000-0000000000aa',
      name: 'charge',
      input: {},
      masked: [],
      steps: [{ name: 'fetch', output: 1 }],
      code: 'X_PLANTED',
      step: 'charge',
    };
    const path = await fileWith('job.json', { ...BUNDLE, id: failure.jobId, subject: failure });
    const { code } = await run(['repro', path, '--framework', CHECKOUT, '--json']);
    expect(code).toBe(0);
    const dir = join(parent, 'repro-000000000000');
    expect(filesUnder(dir).some((file) => /^repro\/.+\.job\.test\.ts$/.test(file))).toBe(true);
  });

  test('a --framework that is no Ultimate checkout is refused before anything is written', async () => {
    const path = await fileWith('elsewhere.json', {
      ...BUNDLE,
      subject: { ...SUBJECT, requestId: 'req-elsewhere' },
    });
    const before = filesUnder(parent).length;
    const { code, out } = await run(['repro', path, '--framework', parent, '--json']);
    expect(code).toBe(1);
    expect(codeOf(out)).toBe('X_CLI_BAD_FLAG');
    expect(out).toContain('has no packages/core');
    expect(filesUnder(parent).length).toBe(before);
  });

  test('a file that is not JSON is X_REPRO_BUNDLE_INVALID', async () => {
    const path = join(parent, 'not-json.json');
    await Bun.write(path, '{ "format": ');
    const { out } = await run(['repro', path, '--json']);
    expect(codeOf(out)).toBe('X_REPRO_BUNDLE_INVALID');
  });

  test('a missing file is X_REPRO_BUNDLE_INVALID', async () => {
    const { out } = await run(['repro', join(parent, 'missing.json'), '--json']);
    expect(codeOf(out)).toBe('X_REPRO_BUNDLE_INVALID');
  });

  test('`repro` alone is still an app named repro', async () => {
    const { code, out } = await run(['repro', '--dry-run', '--json']);
    expect(code).toBe(0);
    expect((JSON.parse(out) as { command: string }).command).toBe('new');
  });
});
