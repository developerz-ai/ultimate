// `ci-changes`: which diffs may skip the jobs no markdown can reach, and that every doubt runs them.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: Bun ships no path API.
import { classifyChanges, parseChangedFiles } from './ci-changes';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unit · ci-changes · a diff that only moves prose skips the heavy jobs', () => {
  test('wiki, docs and root markdown alone: heavy is false', () => {
    const verdict = classifyChanges([
      'wiki/Error-Codes.md',
      'wiki/nested/Page.md',
      'docs/history/ci-split.md',
      'README.md',
      'CLAUDE.md',
    ]);
    expect(verdict.heavy).toBe(false);
    expect(verdict.code).toEqual([]);
  });

  // A plan's tracker is read by the gate's `roadmap` and plan guards, which run on every diff; no
  // heavy job reads `docs/` at all. PR #1377 ran every heavy job for one `status.yml` of 15 paths.
  test('a plan`s status.yml, beside its markdown: heavy is false', () => {
    const verdict = classifyChanges([
      'docs/plans/2026/11/27/101-finish-ultimate-close-issues/status.yml',
      'docs/plans/2026/11/27/101-finish-ultimate-close-issues/README.md',
    ]);
    expect(verdict.heavy).toBe(false);
  });

  test('one path outside the allowlist runs everything, and is named', () => {
    const verdict = classifyChanges(['wiki/Home.md', 'packages/core/src/errors.ts']);
    expect(verdict.heavy).toBe(true);
    expect(verdict.code).toEqual(['packages/core/src/errors.ts']);
  });

  // Every path the coordinator's brief names, and markdown that ships or is read by a job.
  test.each([
    'packages/core/README.md',
    'packages/cli/CLAUDE.md',
    'scripts/README.md',
    'docker/README.md',
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS.md',
    'examples/dummy/README.md',
    'dummy/docs-site/README.md',
    'bun.lock',
    'package.json',
    'tsconfig.json',
    'tsconfig.base.json',
    'biome.json',
    'docs/plans/2026/11/01/x/status.yaml',
    'docs/plans/2026/11/01/x/data.json',
    'wiki/status.yml',
    'wiki/images/diagram.png',
    'llms.txt',
    'framework.manifest.json',
  ])('%s runs everything', (path) => {
    expect(classifyChanges([path]).heavy).toBe(true);
  });

  test('an empty diff proves nothing: heavy', () => {
    expect(classifyChanges([]).heavy).toBe(true);
  });

  // git quotes a path with unusual bytes, and a path that climbs out is not a repo path.
  test.each([
    '"docs/caf\\303\\251.md"',
    '../wiki/Home.md',
    '/wiki/Home.md',
    'wiki/../packages/x.md',
    'docs/.md',
    'docs/.yml',
  ])('%s is not proven prose', (path) => {
    expect(classifyChanges([path]).heavy).toBe(true);
  });
});

describe('unit · ci-changes · the list a step hands it', () => {
  test('one path a line, blank lines and CRLF dropped', () => {
    expect(parseChangedFiles('wiki/Home.md\r\n\ndocs/a.md\n')).toEqual([
      'wiki/Home.md',
      'docs/a.md',
    ]);
  });

  test('no list at all — the diff step failed — is heavy', () => {
    expect(classifyChanges(parseChangedFiles(undefined)).heavy).toBe(true);
  });
});

// The workflow reads `.data.heavy` and `.data.scaffold.matrix` off this document: a renamed key is
// an empty output there, so the wire is held here, by running the script as `changes` runs it.
describe('unit · ci-changes · the document the changes job reads', () => {
  const run = async (paths: string, event: string): Promise<Record<string, unknown>> => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-changes-'));
    const list = join(dir, 'changed.txt');
    await Bun.write(list, paths);
    try {
      const child = Bun.spawn(
        ['bun', 'run', 'scripts/ci-changes.ts', list, '--event', event, '--json'],
        { cwd: repoRoot(), stdout: 'pipe', stderr: 'pipe' },
      );
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const doc: unknown = JSON.parse(out);
      return (doc as { data: Record<string, unknown> }).data;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test('a pull request away from the scaffold code: heavy, and the sampled matrix', async () => {
    const data = await run('packages/ui/src/button.tsx\n', 'pull_request');
    expect(data['heavy']).toBe(true);
    const scaffold = data['scaffold'] as { full: boolean; matrix: { include: unknown[] } };
    expect(scaffold.full).toBe(false);
    expect(scaffold.matrix.include).toHaveLength(3);
  });

  test('a push: every scaffold row', async () => {
    const data = await run('packages/ui/src/button.tsx\n', 'push');
    const scaffold = data['scaffold'] as { full: boolean; matrix: { include: unknown[] } };
    expect(scaffold.full).toBe(true);
    expect(scaffold.matrix.include.length).toBeGreaterThan(3);
  });
});
