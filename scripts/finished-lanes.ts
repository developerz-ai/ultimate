// The finished row "lanes exist": `next` (where a break waits), `release/<prev>.x` (the previous
// major's security branch) and npm's `maint-<prev>` dist-tag naming a `<prev>.x` version, where
// `<prev>` is one below the stamped major. Read through injected `gh` and `npm` runners.

import { renderFixShellArg } from '../packages/core/src/error-render';
import type { FinishedRow, Runner } from './finished-rule';
import { green, isRecord, parsedOutput, red, unverdicted } from './finished-rule';
import type { Finding } from './lib/log';

const refsArgs = (prefix: string): readonly string[] => [
  'api',
  `repos/{owner}/{repo}/git/matching-refs/heads/${prefix}`,
  '--jq',
  '.[].ref',
];
const DIST_TAGS = ['view', '@ultimat3/core', 'dist-tags', '--json'];

export const lanesCommand = (prev: number): string =>
  [
    `gh ${refsArgs('next').join(' ')}`,
    `gh ${refsArgs(`release/${prev}.x`).join(' ')}`,
    `npm ${DIST_TAGS.join(' ')}`,
  ].join('; ');

const absent = (cause: string, fix: string): Finding => ({
  code: 'X_FINISHED_LANE_ABSENT',
  cause,
  fix,
  at: 'SECURITY.md',
});

/** `stamped` is the repository's version (`31.36.0`); the previous major's lanes are read. */
export async function lanesRow(
  stamped: string,
  root: string,
  runners: { readonly gh: Runner; readonly npm: Runner },
): Promise<FinishedRow> {
  const major = Number.parseInt(stamped, 10);
  const prev = major - 1;
  const command = lanesCommand(prev);
  if (!Number.isInteger(major) || prev < 0) {
    return unverdicted('lanes-exist', 'package.json version', `${stamped} names no major`);
  }
  const branch = `release/${prev}.x`;
  const [next, release, tags] = await Promise.all([
    runners.gh(refsArgs('next'), root),
    runners.gh(refsArgs(branch), root),
    runners.npm(DIST_TAGS, root),
  ]);
  const distTags = parsedOutput(tags);
  if (!next.ok || !release.ok || !isRecord(distTags)) {
    return unverdicted('lanes-exist', command, 'gh or npm answered no readable document');
  }
  const has = (output: string, ref: string): boolean =>
    output.split('\n').some((line) => line.trim() === `refs/heads/${ref}`);
  const tag = distTags[`maint-${prev}`];
  const prevArg = renderFixShellArg(String(prev), '<major>');
  const findings: Finding[] = [
    ...(has(next.output, 'next')
      ? []
      : [
          absent(
            'origin has no next branch, so a breaking change has no lane to wait on (X_BREAKING_ON_MAIN)',
            'git push origin origin/main:refs/heads/next   # then: gh workflow run next-sync.yml',
          ),
        ]),
    ...(has(release.output, branch)
      ? []
      : [
          absent(
            `origin has no ${branch} branch for the previous major's security patches`,
            `bun run scripts/release-maint.ts --major ${prevArg} --dry-run --json`,
          ),
        ]),
    ...(typeof tag === 'string' && tag.startsWith(`${prev}.`)
      ? []
      : [
          absent(
            `npm's maint-${prev} dist-tag for @ultimat3/core is ${typeof tag === 'string' ? tag : 'absent'}, not a ${prev}.x version`,
            `bun run scripts/release-maint.ts --major ${prevArg} --dry-run --json`,
          ),
        ]),
  ];
  return findings.length === 0
    ? green('lanes-exist', `next, ${branch} and maint-${prev} (${String(tag)}) all exist`)
    : red('lanes-exist', `${findings.length} of 3 lanes absent`, findings);
}
