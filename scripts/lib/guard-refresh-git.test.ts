// The guard-refresh rule's git half, over a recorded git: which tags bound the ranges (a bump PR's
// untagged newest section skipped), a tag fetched only when origin holds it and never at depth in a
// full clone, and an unanswerable tag reported rather than read as clean.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './changelog-sections';
import type { GitRunner } from './git-fetch';
import { guardRefreshFindings, releaseBounds } from './guard-refresh-git';

const CHANGELOG = parseChangelog(
  '## [Unreleased]\n\nx\n\n## 31.4.2 - 2026-11-12\n\nx\n\n## 31.4.1 - 2026-11-11\n\nx\n\n## 31.4.0 - 2026-11-10\n\nx\n',
);

const T = 'packages/cli/src/templates';

/** A git whose local tags, shallowness and diffs are given; every call is recorded. */
function fakeGit(state: { tags: Set<string>; shallow?: boolean; diffs?: Record<string, string> }): {
  readonly runner: GitRunner;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = async (command) => {
    calls.push([...command]);
    const args = command.slice(1);
    const answer = (ok: boolean, output = '') => ({
      command,
      ok,
      code: ok ? 0 : 1,
      output,
      durationMs: 0,
      timedOut: false,
    });
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
      return answer(true, state.shallow === true ? 'true' : 'false');
    }
    if (args[0] === 'rev-parse') {
      const tag = /refs\/tags\/([^^]+)/.exec(args.at(-1) ?? '')?.[1] ?? '';
      return answer(state.tags.has(tag));
    }
    if (args[0] === 'fetch') {
      const tag = /refs\/tags\/([^:]+):/.exec(args.at(-1) ?? '')?.[1];
      if (tag !== undefined) state.tags.add(tag);
      return answer(true);
    }
    if (args[0] === 'diff') {
      const refs = args.slice(3, args.indexOf('--')).join(' ');
      return answer(true, state.diffs?.[refs] ?? '');
    }
    return answer(false);
  };
  return { runner, calls };
}

describe('releaseBounds', () => {
  test('a bump PR`s newest section is untagged on origin: the one below it is the latest', async () => {
    const { runner } = fakeGit({ tags: new Set(['v31.4.1', 'v31.4.0']) });
    const probe = async (tag: string) => tag !== 'v31.4.2';
    expect(await releaseBounds('/r', CHANGELOG, runner, probe)).toEqual({
      latest: '31.4.1',
      previous: '31.4.0',
    });
  });

  test('a tag origin holds and this clone lacks is fetched — never at depth into a full clone', async () => {
    const { runner, calls } = fakeGit({ tags: new Set(['v31.4.1']) });
    const bounds = await releaseBounds('/r', CHANGELOG, runner, async (tag) => tag !== 'v31.4.2');
    expect(bounds).toEqual({ latest: '31.4.1', previous: '31.4.0' });
    const fetches = calls.filter((call) => call[1] === 'fetch');
    expect(fetches.map((call) => call.at(-1))).toEqual(['+refs/tags/v31.4.0:refs/tags/v31.4.0']);
    expect(fetches.flat()).not.toContain('--depth=1');
  });

  test('in a shallow clone the fetch is depth 1', async () => {
    const { runner, calls } = fakeGit({ tags: new Set(['v31.4.1']), shallow: true });
    await releaseBounds('/r', CHANGELOG, runner, async (tag) => tag !== 'v31.4.2');
    expect(calls.find((call) => call[1] === 'fetch')).toContain('--depth=1');
  });

  test('a remote that cannot answer is X_RELEASE_TAG_UNREACHABLE, never a clean read', async () => {
    const { runner } = fakeGit({ tags: new Set() });
    const bounds = await releaseBounds('/r', CHANGELOG, runner, async () => undefined);
    expect('finding' in bounds && bounds.finding.code).toBe('X_RELEASE_TAG_UNREACHABLE');
    expect('finding' in bounds && bounds.finding.fix).toStartWith('git fetch --no-tags origin ');
  });
});

describe('guardRefreshFindings', () => {
  const diffs = {
    'v31.4.0 v31.4.1': `${T}/guard-bare-error.ts\n${T}/guard-local-binding.ts\n${T}/guard-bare-error.test.ts\n`,
    'v31.4.1': `${T}/guard-raw-motion.ts\n`,
  };
  const options = (runner: GitRunner) => ({
    runner,
    probe: async (tag: string) => tag !== 'v31.4.2',
    shipped: ['bare-error', 'raw-fetch', 'raw-motion'],
    importers: async (stem: string) => (stem === 'local-binding' ? ['raw-fetch'] : []),
  });

  test('templates changed in the release and since it, with no row: one finding per range', async () => {
    const { runner } = fakeGit({ tags: new Set(['v31.4.0', 'v31.4.1']), diffs });
    const findings = await guardRefreshFindings('/r', CHANGELOG, '# Upgrading\n', options(runner));
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_DOC_GUARD_REFRESH_UNSTATED',
      'X_DOC_GUARD_REFRESH_UNSTATED',
    ]);
    expect(findings[0]?.cause).toContain('31.4.0 → 31.4.1: bare-error, raw-fetch');
    expect(findings[1]?.cause).toContain('31.4.1 → [Unreleased]: raw-motion');
  });

  test('with the rows: green', async () => {
    const { runner } = fakeGit({ tags: new Set(['v31.4.0', 'v31.4.1']), diffs });
    const page = [
      '| **31.4.1** changed `bare-error`, `raw-fetch` | `x g guard <name> --force` |',
      '| **31.4.2** changes `raw-motion` | `x g guard raw-motion --force` |',
    ].join('\n');
    expect(await guardRefreshFindings('/r', CHANGELOG, page, options(runner))).toEqual([]);
  });
});
