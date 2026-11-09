#!/usr/bin/env bun
// Enforce, as a gate rule, wiki/Stability.md's deprecation promise: a name a package's
// `src/index.ts` exported at the previous release tag and exports no longer must have carried
// `@deprecated` in that tag. Removals land in a major only after an alias said so for a minor.
//
// Inert while the previous release is below v31 (`WINDOW_OPENS_AT_MAJOR`, the 2026-11-09 ruling):
// the clock starts there, and v31 takes this plan's removals as scheduled. The rule bites from the
// first v31.x.
//
//   bun run scripts/deprecation-window.ts [--json]

// why: the LEAF module, never the `@ultimat3/cli` barrel — the same import registry-audit.ts makes.
import { quoteArg } from '../packages/cli/src/shell-quote';
import { parseScriptArgs } from './lib/args';
import { parseChangelog } from './lib/changelog-sections';
import { deprecatedIn, exportedNames, moduleCandidates } from './lib/export-names';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { recordedException, WINDOW_OPENS_AT_MAJOR } from './lib/major-window';
import { git } from './lib/release-due-git';
import { repoRoot } from './lib/run';
import { listWorkspaces, publishOrder } from './lib/workspaces';
import { remoteTagProbe, type TagProbe } from './registry-audit';

const SCRIPT = 'deprecation-window';

export interface WindowPackage {
  readonly name: string;
  readonly dir: string;
}

export interface WindowOptions {
  readonly probe?: TagProbe;
  readonly packages?: readonly WindowPackage[];
}

/** A file at a ref, or undefined when the ref does not hold it. */
const showAt = async (root: string, ref: string, path: string): Promise<string | undefined> => {
  const shown = await git(['show', `${ref}:${path}`], root);
  return shown.ok ? shown.output : undefined;
};

const unreachable = (tag: string): Finding => ({
  code: 'X_RELEASE_TAG_UNREACHABLE',
  cause: `${tag} is the release this tree's exports are compared against, and neither this clone nor origin could answer for it — a shallow or tagless clone, or a remote that could not be asked`,
  fix: `git fetch --depth=1 --no-tags origin ${quoteArg(`+refs/tags/${tag}:refs/tags/${tag}`)} && bun run scripts/deprecation-window.ts --json`,
  at: 'CHANGELOG.md',
});

/**
 * The tag to compare against: the newest released CHANGELOG.md section that origin holds a tag
 * for. On a bump PR the newest section is the version being cut, untagged, so the one below it is
 * the base. `inert` when that base is below `WINDOW_OPENS_AT_MAJOR`.
 */
async function baseTag(
  root: string,
  changelog: string,
  probe: TagProbe,
): Promise<{ readonly tag: string } | { readonly inert: true } | { readonly finding: Finding }> {
  const released = parseChangelog(changelog)
    .filter((section) => section.released && /^\d+\.\d+\.\d+$/.test(section.version))
    .slice(0, 2);
  for (const section of released) {
    if (Number.parseInt(section.version, 10) < WINDOW_OPENS_AT_MAJOR) return { inert: true };
    const tag = `v${section.version}`;
    if ((await git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], root)).ok) {
      return { tag };
    }
    const held = await probe(tag);
    if (held === undefined) return { finding: unreachable(tag) };
    if (!held) continue;
    const fetched = await git(
      [
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        'origin',
        `+refs/tags/${tag}:refs/tags/${tag}`,
      ],
      root,
    );
    return fetched.ok ? { tag } : { finding: unreachable(tag) };
  }
  const newest = released[0];
  return newest === undefined ? { inert: true } : { finding: unreachable(`v${newest.version}`) };
}

/** Whether `local`, exported as `name` from `barrel` at `tag`, was marked `@deprecated` there. */
async function wasDeprecated(
  root: string,
  tag: string,
  barrel: { readonly path: string; readonly source: string },
  exported: { readonly name: string; readonly local: string; readonly from?: string },
): Promise<boolean> {
  if (deprecatedIn(barrel.source, exported.name) || deprecatedIn(barrel.source, exported.local)) {
    return true;
  }
  if (exported.from === undefined) return false;
  const dir = barrel.path.slice(0, barrel.path.lastIndexOf('/'));
  for (const candidate of moduleCandidates(dir, exported.from)) {
    const source = await showAt(root, tag, candidate);
    if (source !== undefined) return deprecatedIn(source, exported.local);
  }
  return false;
}

export async function deprecationWindowFindings(
  root: string,
  options: WindowOptions = {},
): Promise<readonly Finding[]> {
  const changelog = await Bun.file(`${root}/CHANGELOG.md`)
    .text()
    .catch(() => '');
  // The security exception, as for the major window: recorded under [Unreleased] or the release.
  if (recordedException(changelog, 'unreleased') !== undefined) return [];
  const base = await baseTag(root, changelog, options.probe ?? remoteTagProbe(root));
  if ('inert' in base) return [];
  if ('finding' in base) return [base.finding];
  const packages = options.packages ?? publishOrder(await listWorkspaces(root));
  const findings: Finding[] = [];
  for (const pkg of packages) {
    const path = `packages/${pkg.dir}/src/index.ts`;
    const before = await showAt(root, base.tag, path);
    const now = Bun.file(`${root}/${path}`);
    if (before === undefined || !(await now.exists())) continue;
    const kept = new Set(exportedNames(await now.text()).map((one) => one.name));
    for (const gone of exportedNames(before).filter((one) => !kept.has(one.name))) {
      if (await wasDeprecated(root, base.tag, { path, source: before }, gone)) continue;
      findings.push({
        code: 'X_RELEASE_UNDEPRECATED_REMOVAL',
        cause: `${pkg.name} no longer exports \`${gone.name}\`, and ${base.tag}'s ${path} never marked it @deprecated — a removal or rename ships its alias with @deprecated on main for at least one minor first (wiki/Stability.md)`,
        fix: `git show ${quoteArg(`${base.tag}:${path}`)}   # restore \`${gone.name}\` in ${path} with a /** @deprecated */ comment naming its replacement, and remove it in the next major window`,
        at: path,
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await deprecationWindowFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'every export the previous release tag held is still exported, or was @deprecated there'
          : `${findings.length} export(s) removed with no prior @deprecated`,
      findings,
    },
    args.json,
  );
}
