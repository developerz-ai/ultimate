// A generated file may not import a module the same run does not also write. Four generators did:
// `x g job|task|query|action` into a slice with no `entity.ts`/`repo.ts`/`policy.ts` emitted
// `import * as repo from '../repo'` against nothing, so the second command an agent runs after
// `x new` produced TS2307 and `x build` failed. The closure test below is the build error.

import { describe, expect, test } from 'bun:test';
import { GENERATORS, generate, writeFiles } from '../cmd-generate';
import { stripComments } from '../ts-scan';
import type { GeneratedFile } from './naming';
import { sliceFoundation } from './slice-foundation';

const target = { surfaceDir: 'apps/web/app', feature: 'invoice' } as const;

/** POSIX dirname, and POSIX only: `GeneratedFile.path` is documented relative-POSIX. */
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** `a/b/../c` → `a/c`. The emitted specifiers are hand-written, so `.`/`..` is all there is. */
const normalize = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
};

/**
 * Every relative specifier an emitted file imports from. Comments are masked first through the
 * `errors` step's own scanner rather than a second one here, because a generated comment explaining
 * app boot (`registerQueries(await import('./live'))`) is prose, not an edge.
 */
const relativeImports = (contents: string): readonly string[] =>
  [...stripComments(contents).matchAll(/\bfrom\s+'(\.[^']*)'/g)].flatMap((match) => match[1] ?? []);

/** What the generated import would have to find on disk, in the order a bundler would try. */
const candidates = (from: string, specifier: string): readonly string[] => {
  const base = normalize(`${dirOf(from)}/${specifier}`);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
};

const unresolved = (files: readonly GeneratedFile[]): readonly string[] => {
  const emitted = new Set(files.map((file) => file.path));
  return files.flatMap((file) =>
    typeof file.contents !== 'string'
      ? []
      : relativeImports(file.contents).flatMap((specifier) =>
          candidates(file.path, specifier).some((path) => emitted.has(path))
            ? []
            : [`${file.path} → ${specifier}`],
        ),
  );
};

describe('unit · a generator emits every slice module it imports', () => {
  // The whole defect in one assertion, over all thirteen generators at once: run any of them into a
  // feature that does not exist yet and every relative import in what it wrote must land on a file
  // the same run wrote. `x g task` is included on purpose — it imports nothing itself and composes
  // the job that does, which is why reading `task.ts` alone says it is fine.
  test('no generated file imports a module the same generation does not write', () => {
    const offenders = GENERATORS.flatMap((kind) =>
      unresolved(generate({ kind, name: 'send-invoice', feature: 'invoice' })).map(
        (line) => `x g ${kind}: ${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  test('a live query closes over its slice too — the flag changes the directory, not the imports', () => {
    expect(
      unresolved(generate({ kind: 'query', name: 'invoice-feed', feature: 'invoice', live: true })),
    ).toEqual([]);
  });

  test('a resource is closed the same way, and is the shape the other generators borrow', () => {
    expect(unresolved(generate({ kind: 'resource', name: 'invoice', admin: true }))).toEqual([]);
  });
});

describe('unit · the foundation is the slice, not the generator', () => {
  const pathsOf = (files: readonly GeneratedFile[]): readonly string[] =>
    files.map((file) => file.path);

  test('entity brings repo with it — repo.ts imports ./entity, so half of the pair is broken', () => {
    expect(pathsOf(sliceFoundation(target, ['entity']))).toEqual([
      'apps/web/app/invoice/entity.ts',
      'apps/web/app/invoice/entity.test.ts',
      'apps/web/app/invoice/repo.ts',
    ]);
  });

  test('each generator asks for exactly what its source imports, and nothing else', () => {
    // A job that imports only `../repo` must not also plant a policy the job never evaluates:
    // a generated file nobody asked for is one an author has to read before deleting.
    const jobPaths = pathsOf(generate({ kind: 'job', name: 'sweep', feature: 'invoice' }));
    expect(jobPaths).toContain('apps/web/app/invoice/repo.ts');
    expect(jobPaths).not.toContain('apps/web/app/invoice/policy.ts');
    const queryPaths = pathsOf(generate({ kind: 'query', name: 'recent', feature: 'invoice' }));
    expect(queryPaths).toContain('apps/web/app/invoice/policy.ts');
    // A query reads; it declares no error type of its own.
    expect(queryPaths).not.toContain('apps/web/app/invoice/errors.ts');
  });

  test('a task closes over the slice through the job it composes', () => {
    const paths = pathsOf(generate({ kind: 'task', name: 'nightly', feature: 'invoice' }));
    expect(paths).toContain('apps/web/app/invoice/repo.ts');
    expect(paths).toContain('apps/web/app/invoice/jobs/nightly-job.ts');
  });

  test('every foundation file is if-absent — a generator never rewrites a slice it did not create', () => {
    for (const file of sliceFoundation(target, ['entity', 'policy', 'errors'])) {
      expect(file.merge).toBe('if-absent');
    }
  });

  test('a resource still OWNS its slice: the plain write wins the dedupe, so a rerun conflicts', () => {
    const files = generate({ kind: 'resource', name: 'invoice' });
    const paths = files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const owned of ['entity.ts', 'policy.ts', 'repo.ts']) {
      const file = files.find((entry) => entry.path === `apps/web/app/invoice/${owned}`);
      expect({ [owned]: file?.merge }).toEqual({ [owned]: undefined });
    }
  });
});

describe('unit · what the writer does with an if-absent file', () => {
  const root = (): string =>
    `${process.env['TMPDIR'] ?? '/tmp'}/x-slice-foundation-${Bun.randomUUIDv7()}`;

  // This is the half of the mechanism `cmd-generate.ts` owns, pinned from here because the
  // templates are what depend on it: without this branch every `x g action --feature <existing>`
  // reports X_GENERATE_CONFLICT on the slice's own entity.ts and writes nothing at all.
  test('an if-absent file is written when the slice does not have it', async () => {
    const dir = root();
    const report = await writeFiles(
      dir,
      [{ path: 'apps/web/app/invoice/repo.ts', contents: 'export {};\n', merge: 'if-absent' }],
      false,
    );
    expect(report.conflicts).toEqual([]);
    expect(report.written).toEqual(['apps/web/app/invoice/repo.ts']);
  });

  test('an if-absent file is left alone when it exists — never a conflict, never a clobber', async () => {
    const dir = root();
    const path = 'apps/web/app/invoice/repo.ts';
    const mine = '// the author edited this\n';
    await Bun.write(`${dir}/${path}`, mine);
    for (const force of [false, true]) {
      const report = await writeFiles(
        dir,
        [{ path, contents: 'export {};\n', merge: 'if-absent' }],
        force,
      );
      // `--force` is about the primitive the author named, never about the slice around it:
      // overwriting policy.ts would delete every rule they wrote to regenerate one action.
      expect({ force, conflicts: report.conflicts, written: report.written }).toEqual({
        force,
        conflicts: [],
        written: [],
      });
    }
    expect(await Bun.file(`${dir}/${path}`).text()).toBe(mine);
  });

  test('an if-absent file never holds back the rest of the set', async () => {
    const dir = root();
    await Bun.write(`${dir}/apps/web/app/invoice/repo.ts`, 'export {};\n');
    const report = await writeFiles(
      dir,
      [
        { path: 'apps/web/app/invoice/repo.ts', contents: 'export {};\n', merge: 'if-absent' },
        { path: 'apps/web/app/invoice/jobs/sweep.ts', contents: 'export {};\n' },
      ],
      false,
    );
    expect(report.conflicts).toEqual([]);
    expect(report.written).toEqual(['apps/web/app/invoice/jobs/sweep.ts']);
  });
});
