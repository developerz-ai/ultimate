// Which repository, which pull request, which branch — the three facts `x pr` and `x ci` both
// need before they can ask GitHub anything, resolved once here so the two commands can never
// disagree about what "this checkout" means.

import { UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { BadFlagError } from './errors';
import type { GhHost } from './gh';
import { GhFailedError, ghJson } from './gh';

/** `owner/name`, split once so a caller never re-splits it and never re-joins it wrong. */
export interface GhRepo {
  readonly owner: string;
  readonly name: string;
  /** The `owner/name` spelling, which is what `--repo` takes and what every render prints. */
  readonly slug: string;
}

/**
 * A repository name is `[A-Za-z0-9._-]+` on both sides of one slash. Refused here rather than by
 * GitHub, because `--repo` is the one field a caller types by hand: `--repo ultimate` reaches the
 * API as an owner with no name and comes back `Could not resolve to a Repository`, which reads as
 * "that repository is gone" rather than "that is not a repository reference".
 */
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const REPO_VIEW = t.object({ nameWithOwner: t.string });

/** No pull request for the branch this checkout is on. A number the caller knows closes it. */
export class PrNotFoundError extends UltimateError {
  constructor(input: { detail: string }) {
    super({
      code: 'X_PR_NOT_FOUND',
      cause: `GitHub reports no pull request for this checkout: ${input.detail}`,
      fix: 'x pr review --pr 241 --json   # or open one first with: gh pr create',
    });
  }
}

/**
 * The repository this command is about. `--repo` when given, otherwise `gh repo view`, which
 * resolves the same remote `gh pr` and `gh run` resolve — asking git for the remote here would be
 * a second answer to a question gh already owns.
 */
export async function resolveRepo(
  host: GhHost,
  command: string,
  flag: string | undefined,
): Promise<GhRepo> {
  if (flag !== undefined) {
    if (!SLUG.test(flag)) {
      throw new BadFlagError({
        flag: 'repo',
        command,
        reason: `"${flag}" is not an owner/name repository reference`,
        fix: `x ${command} --repo developerz-ai/ultimate --json`,
      });
    }
    return repoOf(flag);
  }
  const viewed = await ghJson(host, ['repo', 'view', '--json', 'nameWithOwner'], REPO_VIEW, {
    label: 'gh repo view',
    fix: `x ${command} --repo developerz-ai/ultimate --json`,
  });
  return repoOf(viewed.nameWithOwner);
}

function repoOf(slug: string): GhRepo {
  const [owner = '', name = ''] = slug.split('/');
  return { owner, name, slug };
}

const PR_VIEW = t.object({ number: t.number });

/**
 * The pull request for the current branch. gh exits non-zero when there is none, with a message
 * that names the branch — so the refusal keeps gh's own sentence and adds the remedy gh has no
 * opinion about: name the number, or open the PR.
 */
export async function resolvePrNumber(host: GhHost, repo: GhRepo): Promise<number> {
  try {
    const viewed = await ghJson(
      host,
      ['pr', 'view', '--repo', repo.slug, '--json', 'number'],
      PR_VIEW,
      { label: 'gh pr view', fix: 'x pr review --pr 241 --json' },
    );
    return viewed.number;
  } catch (error) {
    if (error instanceof GhFailedError) throw new PrNotFoundError({ detail: error.cause });
    throw error;
  }
}

/**
 * The branch this checkout is on, from git rather than from gh: gh has no "current branch"
 * question, only commands that answer one for you. A detached HEAD answers `HEAD`, which matches
 * no branch on GitHub — the caller's own "no run for this branch" refusal names `--branch`, so a
 * second refusal here would only move the same instruction one step earlier.
 *
 * Spawn failures are deliberately NOT caught: `exec.ts` refuses a missing program with a fix that
 * already names `git`, and re-labelling that as a GitHub problem would send the reader to the
 * wrong install.
 */
export async function currentBranch(host: GhHost): Promise<string> {
  const result = await host.runner(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: host.cwd,
  });
  if (!result.ok) {
    throw new GhFailedError({
      label: 'git rev-parse --abbrev-ref HEAD',
      code: result.code,
      detail: result.stderr.split('\n')[0]?.trim() ?? '',
      fix: 'x ci --branch main --json',
    });
  }
  return result.stdout.trim();
}
