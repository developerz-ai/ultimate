// Row 9's read, judge and command: whether the GitHub Release for the last tag exists and is
// published. The lookup union keeps gh's OWN "release not found" refusal — the half-cut release
// release-tag.yml leaves when its Release step fails — apart from every other refusal, which is
// `cannot tell` for the whole checkup.

import type { ReleaseDoc } from './health-narrow';
import { jsonDocument, narrowRelease } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import { gh } from './release-due-gh';
import { git } from './release-due-git';
import type { RunResult } from './run';

// Exported for the test that pins it against the argv the reader actually spawns: the command the
// refusal quotes must be the command the row ran, so a re-run is the same query. The tag is BARE —
// git describe already names it `v3.0.0`, and a `v` in front would ask for `vv3.0.0`.
export const RELEASE_EXISTS_COMMAND =
  "git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main; gh release view <tag> --json tagName,isDraft,publishedAt";

/**
 * What `gh release view` answered for the tag. `missing` is gh's OWN refusal — it says
 * `release not found` and prints no JSON document — and is a verdict, never a refusal to read:
 * gh's exit code cannot say this (`gh help exit-codes` — every failure exits 1), so the message,
 * not the exit status, is the signal.
 */
export type ReleaseLookup =
  | { readonly kind: 'found'; readonly release: ReleaseDoc }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly detail: string };

/** What row 9's reader answers: the tag it resolved, and the Release lookup over it. */
export interface ReleaseExistsRead {
  readonly tag: string | undefined;
  readonly lookup: ReleaseLookup;
}

/**
 * The child runners the reader spawns: the real bounded ones by default, stubs in a test. The
 * shape is the same seam `health-readers.ts` names `GhRunner` — declared here because that module
 * composes this one, so importing it back would be a cycle.
 */
export type ChildRunner = (args: readonly string[], cwd: string) => Promise<RunResult>;

const GIT_BROKEN = { ok: false as const, output: '' };

export const releaseExistsReader = async (
  root: string,
  ghRunner: ChildRunner = gh,
  gitRunner: ChildRunner = git,
): Promise<ReleaseExistsRead> => {
  const described = await gitRunner(
    ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'origin/main'],
    root,
  ).catch(() => GIT_BROKEN);
  const tag = described.ok ? described.output.trim() : '';
  if (tag === '') {
    return {
      tag: undefined,
      lookup: { kind: 'refused', detail: 'git could not name the last v* tag on origin/main' },
    };
  }
  const answer = await ghRunner(
    ['release', 'view', tag, '--json', 'tagName,isDraft,publishedAt'],
    root,
  );
  const release = narrowRelease(jsonDocument(answer.output));
  if (release !== undefined) return { tag, lookup: { kind: 'found', release } };
  if (answer.output.includes('release not found')) return { tag, lookup: { kind: 'missing' } };
  const detail =
    answer.output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? 'gh answered nothing';
  return { tag, lookup: { kind: 'refused', detail } };
};

/**
 * Row 9's verdict over what the reader answered. `missing` is UNHEALTHY — the half-cut release —
 * never unreadable: gh answered, and its answer names the defect. A draft, and a Release that
 * names no `publishedAt`, are unhealthy too — the published reading needs `isDraft` false AND a
 * publish time. Every other answer refuses the whole checkup, quoting the row's own command.
 */
export const judgeReleaseExists = (read: ReleaseExistsRead): RowVerdict | Finding => {
  const base = { row: 'release-exists' as const };
  if (read.lookup.kind === 'refused') {
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the release-exists row could not be read: ${RELEASE_EXISTS_COMMAND} — ${read.lookup.detail}`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  if (read.lookup.kind === 'missing') {
    return {
      ...base,
      verdict: 'unhealthy',
      tagName: read.tag,
      reason: `gh finds no GitHub Release for ${read.tag} — the half-cut release release-tag.yml leaves when its Release step fails: the tag exists, no Release names it`,
    };
  }
  const { release } = read.lookup;
  if (release.isDraft) {
    return {
      ...base,
      verdict: 'unhealthy',
      tagName: release.tagName,
      isDraft: true,
      publishedAt: release.publishedAt,
      reason: `the GitHub Release for ${release.tagName} is a draft — release-tag.yml's Release step creates it published, so a draft is a half-cut release nobody published`,
    };
  }
  if (release.publishedAt === undefined) {
    return {
      ...base,
      verdict: 'unhealthy',
      tagName: release.tagName,
      isDraft: false,
      reason: `the GitHub Release for ${release.tagName} names no publishedAt — the published reading needs isDraft false AND a publish time`,
    };
  }
  return {
    ...base,
    verdict: 'healthy',
    tagName: release.tagName,
    isDraft: false,
    publishedAt: release.publishedAt,
    reason: `the GitHub Release for ${release.tagName} is published (${release.publishedAt})`,
  };
};
