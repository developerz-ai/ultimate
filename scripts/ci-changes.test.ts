// `ci-changes`: which diffs may skip the jobs no markdown can reach, and that every doubt runs them.

import { describe, expect, test } from 'bun:test';
import { classifyChanges, parseChangedFiles } from './ci-changes';

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
    'docs/plans/2026/11/01/x/status.yml',
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
