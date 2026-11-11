// The `contract-diff` gate step: the contract the code builds now against the one last committed.
// Split from `verify-checks.ts` (at its ceiling) so the baseline — which file counts as "published"
// — is decided in one place beside the step that reads it.

// why: Bun has no synchronous existence check for `applies`.
import { existsSync } from 'node:fs';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { Manifest } from '@ultimat3/manifest';
import { isManifest, MANIFEST_FILENAME, verifyContract } from '@ultimat3/manifest';
import { DEFAULT_REMOTE, fetchFixFor } from './affected-base';
import { appManifest, readAppManifest } from './app-manifest';
import type { Runner } from './exec';
import { msg } from './messages';
import type { Finding } from './output';
import { findingFrom } from './output';
import type { StepOutcome, VerifyStep } from './verify-step';

type Env = Readonly<Record<string, string | undefined>>;

/** The published contract, and — whenever it is not HEAD's file — the line saying what it is. */
export interface CommittedManifest {
  readonly manifest?: Manifest;
  readonly notice?: string;
}

const file = MANIFEST_FILENAME;

/** A git call that answers `undefined` for every way of not answering — no binary included. */
async function gitOut(root: string, runner: Runner, args: readonly string[]) {
  const result = await runner(['git', ...args], { cwd: root }).catch(() => undefined);
  return result?.ok === true ? result.stdout : undefined;
}

const parsedManifest = (text: string): Manifest | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The commit whose manifest is published. A pull request in CI (`GITHUB_BASE_REF`) has the
 * rebaselined manifest committed at HEAD, so its baseline is the merge base with the target
 * branch. A shallow checkout (CI's: depth 1, the base fetched at depth 1) reaches no merge base, and
 * the fetched base ref itself is then the baseline — on a PR merge commit, its first parent. Only a
 * base that is not fetched at all falls back to HEAD and names the fetch. Everywhere else, HEAD.
 */
async function baselineRev(root: string, runner: Runner, env: Env) {
  const base = env['GITHUB_BASE_REF'];
  if (base === undefined || base === '') return { rev: 'HEAD' };
  const ref = `${DEFAULT_REMOTE}/${base}`;
  const notice = msg('cli.verify.contract.mergeBase', { file, ref });
  const sha = (await gitOut(root, runner, ['merge-base', 'HEAD', ref]))?.trim();
  if (sha !== undefined && sha !== '') return { rev: sha, notice };
  const tip = await gitOut(root, runner, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (tip !== undefined)
    return { rev: ref, notice: msg('cli.verify.contract.baseTip', { file, ref }) };
  return {
    rev: 'HEAD',
    notice: msg('cli.verify.contract.baseUnfetched', { ref, file, fix: fetchFixFor(ref) }),
  };
}

/**
 * The contract as last COMMITTED, never the working-tree file: `x manifest` and every `x g`
 * rewrite that one, so a breaking change diffed against it was green with no decision made (plan
 * 101 19a FX4). Inside a checkout with no file at the baseline (never committed, or no commit yet)
 * nothing is published, so there is no baseline. Outside a checkout (an unpacked tarball, a
 * container with no `.git`) the file on disk is the only contract there is.
 */
export async function committedAppManifest(
  root: string,
  runner: Runner,
  env: Env = {},
): Promise<CommittedManifest> {
  if ((await gitOut(root, runner, ['rev-parse', '--is-inside-work-tree'])) === undefined) {
    const notice = msg('cli.verify.contract.noCheckout', { file });
    const manifest = await readAppManifest(root);
    return manifest === undefined ? { notice } : { manifest, notice };
  }
  const { rev, notice: base } = await baselineRev(root, runner, env);
  const withBase = (notice: string): string => (base === undefined ? notice : `${base}\n${notice}`);
  const text = await gitOut(root, runner, ['show', `${rev}:./${file}`]);
  if (text !== undefined) {
    const manifest = parsedManifest(text);
    if (manifest === undefined)
      return { notice: withBase(msg('cli.verify.contract.notManifest', { file, rev })) };
    return base === undefined ? { manifest } : { manifest, notice: base };
  }
  const head = await gitOut(root, runner, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return {
    notice: withBase(
      head === undefined
        ? msg('cli.verify.contract.noCommit', { file })
        : msg('cli.verify.contract.uncommitted', { file, rev }),
    ),
  };
}

/** A breaking change is allowed — with a major bump. `verifyContract` is the one that decides. */
function contractFindings(before: Manifest, after: Manifest): readonly Finding[] {
  try {
    verifyContract({ before, after });
    return [];
  } catch (error) {
    return [{ ...findingFrom(error), at: MANIFEST_FILENAME }];
  }
}

/**
 * `built` — the manifest the code describes now — against the committed contract
 * (`committedAppManifest`). Whenever the baseline is not HEAD's file, `output` says which.
 */
export async function contractDiffOutcome(
  root: string,
  runner: Runner,
  built: Manifest,
  env: Env = {},
): Promise<StepOutcome> {
  const { manifest, notice } = await committedAppManifest(root, runner, env);
  const findings = manifest === undefined ? [] : contractFindings(manifest, built);
  return {
    ok: findings.length === 0,
    findings,
    ...(notice === undefined ? {} : { output: notice }),
  };
}

export const contractDiffStep: VerifyStep = {
  name: 'contract-diff',
  summary: 'the published contract vs the manifest committed at HEAD (in CI: at the merge base)',
  // A BREAKING change against the committed manifest, and nothing else. Whether the committed
  // files are stale — `openapi.json` included — is the `manifest` step's, through the one check
  // `x manifest --check` runs (`manifest-staleness.ts`).
  applies: async (ctx) => existsSync(join(ctx.root, MANIFEST_FILENAME)),
  async run(ctx) {
    const { manifest } = await appManifest(ctx.root);
    return contractDiffOutcome(ctx.root, ctx.runner, manifest, ctx.env ?? Bun.env);
  },
};
