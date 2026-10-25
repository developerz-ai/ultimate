// Row 9's read, judge and command in isolation: the lookup union's kinds judge to the brief's
// readings — published healthy, draft and missing unhealthy, everything else one unreadable
// refusal quoting the row's own command — and the reader's argv and classification are read off
// runner stubs, no network.

import { describe, expect, test } from 'bun:test';
import { judgeReleaseExists, RELEASE_EXISTS_COMMAND, releaseExistsReader } from './health-release';
import type { RunResult } from './run';

/** A runner that records the argv it was asked for and answers one output. */
const stubRunner = (output: string) => {
  const asked: string[][] = [];
  const runner = async (args: readonly string[]): Promise<RunResult> => {
    asked.push([...args]);
    return {
      command: ['stub', ...args],
      code: 0,
      ok: true,
      output,
      durationMs: 1,
      timedOut: false,
    };
  };
  return { asked, runner };
};

const gitTagless = async (): Promise<RunResult> => ({
  command: ['git'],
  code: 128,
  ok: false,
  output: '',
  durationMs: 1,
  timedOut: false,
});

const PUBLISHED = {
  tag: 'v3.0.0',
  lookup: {
    kind: 'found' as const,
    release: { tagName: 'v3.0.0', isDraft: false, publishedAt: '2026-01-01T00:00:00Z' },
  },
};

describe('unit · health-release · RELEASE_EXISTS_COMMAND', () => {
  test('it resolves the tag with git describe, then asks gh for the Release, tag bare', () => {
    // The exact string the brief's row 9 prescribes — `<tag>` a placeholder, never `v<tag>`:
    // git describe already names it `v3.0.0`, so a `v` in front would ask for `vv3.0.0`.
    expect(RELEASE_EXISTS_COMMAND).toBe(
      "git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main; gh release view <tag> --json tagName,isDraft,publishedAt",
    );
  });
});

describe('unit · health-release · judgeReleaseExists', () => {
  test('a published Release is healthy, carrying the Release fields', () => {
    const verdict = judgeReleaseExists(PUBLISHED);
    expect(verdict).toMatchObject({
      row: 'release-exists',
      verdict: 'healthy',
      tagName: 'v3.0.0',
      isDraft: false,
      publishedAt: '2026-01-01T00:00:00Z',
    });
  });

  test('a draft Release is unhealthy — a draft is not a published one', () => {
    const verdict = judgeReleaseExists({
      ...PUBLISHED,
      lookup: {
        kind: 'found',
        release: { tagName: 'v3.0.0', isDraft: true, publishedAt: '2026-01-01T00:00:00Z' },
      },
    });
    expect(verdict).toMatchObject({ verdict: 'unhealthy', tagName: 'v3.0.0', isDraft: true });
    expect(verdict).toHaveProperty('reason');
    expect((verdict as { reason: string }).reason).toContain('draft');
  });

  test('a Release that names no publishedAt is unhealthy even undrafted', () => {
    const verdict = judgeReleaseExists({
      ...PUBLISHED,
      lookup: {
        kind: 'found',
        release: { tagName: 'v3.0.0', isDraft: false, publishedAt: undefined },
      },
    });
    expect(verdict).toMatchObject({ verdict: 'unhealthy', tagName: 'v3.0.0', isDraft: false });
  });

  test('a missing Release is unhealthy, never unreadable — gh answered', () => {
    const verdict = judgeReleaseExists({ tag: 'v3.0.0', lookup: { kind: 'missing' } });
    expect(verdict).toMatchObject({
      row: 'release-exists',
      verdict: 'unhealthy',
      tagName: 'v3.0.0',
    });
    expect((verdict as { reason: string }).reason).toContain('release-tag.yml');
  });

  test('a refused lookup is one unreadable finding quoting the row command, not a verdict', () => {
    const finding = judgeReleaseExists({
      tag: 'v3.0.0',
      lookup: { kind: 'refused', detail: 'gh answered nothing' },
    });
    expect(finding).toMatchObject({
      code: 'X_HEALTH_ROW_UNREADABLE',
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    });
    expect((finding as { cause: string }).cause).toContain(RELEASE_EXISTS_COMMAND);
    expect((finding as { cause: string }).cause).toContain('gh answered nothing');
  });
});

describe('unit · health-release · releaseExistsReader', () => {
  test('it runs the pinned command — git describe, then gh release view on the bare tag', async () => {
    const ghStub = stubRunner(
      '{"tagName":"v3.0.0","isDraft":false,"publishedAt":"2026-01-01T00:00:00Z"}',
    );
    const gitStub = stubRunner('v3.0.0\n');
    const read = await releaseExistsReader('.', ghStub.runner, gitStub.runner);
    const [describePart = '', viewPart = ''] = RELEASE_EXISTS_COMMAND.split('; ');
    // The command string is the shell form, the argv the spawned form: token for token the same,
    // the string's quotes around `v[0-9]*` belonging to the shell, never to the argv.
    expect(describePart.replaceAll("'", '')).toBe(['git', ...(gitStub.asked[0] ?? [])].join(' '));
    expect(viewPart.replace('<tag>', 'v3.0.0')).toBe(['gh', ...(ghStub.asked[0] ?? [])].join(' '));
    expect(read).toEqual(PUBLISHED);
  });

  test("gh's own `release not found` refusal is a missing Release, not a refusal to read", async () => {
    const ghStub = stubRunner('release not found\n');
    const read = await releaseExistsReader('.', ghStub.runner, stubRunner('v3.0.0\n').runner);
    expect(read).toEqual({ tag: 'v3.0.0', lookup: { kind: 'missing' } });
  });

  test('a document that is not a readable Release is refused, first stderr line as the detail', async () => {
    const read = await releaseExistsReader(
      '.',
      stubRunner('fatal: gh failed for another reason\n').runner,
      stubRunner('v3.0.0\n').runner,
    );
    expect(read).toEqual({
      tag: 'v3.0.0',
      lookup: { kind: 'refused', detail: 'fatal: gh failed for another reason' },
    });
  });

  test('a tag git cannot name is refused before gh is asked at all', async () => {
    const ghStub = stubRunner('{}');
    const read = await releaseExistsReader('.', ghStub.runner, gitTagless);
    expect(read).toEqual({
      tag: undefined,
      lookup: { kind: 'refused', detail: 'git could not name the last v* tag on origin/main' },
    });
    expect(ghStub.asked).toEqual([]);
  });
});
