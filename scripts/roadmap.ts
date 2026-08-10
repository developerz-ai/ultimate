// Turns `docs/idea/14-roadmap.md` from prose into a gate step. Three rules, all decidable without
// running the demo app: (1) the roadmap file exists at all — deleting it must not silently pass
// every other rule; (2) every milestone row carries a status marker — the table this file guards
// shipped with zero, and a silent regression back to that state is exactly the bug a reader would
// not notice; (3) a milestone the table marks shipped still has every artifact its own "Ships"
// column names on disk — a status marker nobody checks is a claim, not a gate.
//
//   bun run scripts/roadmap.ts [--json]

// `existsSync` and `join` have no Bun equivalent for this job: `Bun.file().exists()` is async and
// answers `false` for a directory, and one required artifact (`packages/cli/src/templates`) is a
// directory.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, HostCheck } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const ROADMAP_FILE = 'docs/idea/14-roadmap.md';

export type MilestoneStatus = 'shipped' | 'in-progress';

export const STATUS_MARK: Readonly<Record<MilestoneStatus, string>> = {
  shipped: '✅',
  'in-progress': '🚧',
};

const STATUS_BY_MARK: ReadonlyMap<string, MilestoneStatus> = new Map(
  Object.entries(STATUS_MARK).map(([status, mark]) => [mark, status as MilestoneStatus]),
);

/**
 * Repo-relative paths each milestone's own "Ships" column claims exist, checked only once the
 * table marks that milestone shipped — an in-progress milestone's artifacts are still landing, so
 * their absence is not yet a regression.
 *
 * Status and title are **not** mirrored here: they are read back out of the table itself, so the
 * roadmap is the one place either is stated (axiom 2). Only these paths live in code, because the
 * "Ships" column is prose naming packages, not a machine-readable path list.
 */
export const REQUIRED_ARTIFACTS: Readonly<Record<number, readonly string[]>> = {
  0: [
    'packages/core/src/index.ts',
    'packages/schema/src/index.ts',
    'scripts/boundaries.ts',
    'packages/cli/src/cmd-verify.ts',
  ],
  1: ['packages/http/src/index.ts', 'packages/entity/src/index.ts', 'packages/policy/src/index.ts'],
  2: [
    'packages/action/src/index.ts',
    'packages/query/src/index.ts',
    'packages/cli/src/app-openapi.ts',
  ],
  3: ['packages/render/src/index.ts', 'packages/cli/src/app-boundaries.ts'],
  4: ['packages/seo/src/index.ts', 'packages/cli/src/budgets.ts'],
  5: ['packages/jobs/src/index.ts', 'packages/mail/src/index.ts', 'packages/storage/src/index.ts'],
  6: ['packages/realtime/src/index.ts'],
  7: ['packages/cache/src/index.ts'],
  8: ['packages/pwa/src/index.ts'],
  9: ['packages/ai/src/index.ts', 'packages/mcp/src/index.ts'],
  10: [
    'packages/admin/src/index.ts',
    'packages/create-ultimate/src/index.ts',
    'packages/cli/src/templates',
  ],
  11: [
    'docker/Dockerfile',
    'docker/docker-compose.dev.yml',
    'docker/docker-compose.prod.yml',
    'docker/helm',
    'packages/cli/src/cmd-build.ts',
    'wiki/Error-Codes.md',
    'CHANGELOG.md',
  ],
};

export const MILESTONE_NUMBERS: readonly number[] = Object.keys(REQUIRED_ARTIFACTS)
  .map(Number)
  .sort((a, b) => a - b);

export interface MilestoneRow {
  readonly n: number;
  readonly status: MilestoneStatus;
  readonly title: string;
}

/**
 * Read milestone `n` back out of its own `| n | marker | **Title** | ships | done when |` row.
 * `undefined` means the row is absent, or present with no marker this table defines — the two
 * cases rule (2) exists to catch, and the caller reports them identically.
 */
export function milestoneRow(markdown: string, n: number): MilestoneRow | undefined {
  const line = markdown
    .split('\n')
    .find((candidate) => new RegExp(`^\\|\\s*${n}\\s*\\|`).test(candidate));
  if (line === undefined) return undefined;
  const cells = line.split('|').map((cell) => cell.trim());
  const marker = [...STATUS_BY_MARK.keys()].find((mark) => cells[2]?.includes(mark) === true);
  const status = marker === undefined ? undefined : STATUS_BY_MARK.get(marker);
  if (status === undefined) return undefined;
  return { n, status, title: (cells[3] ?? '').replaceAll('*', '').trim() };
}

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

const missingFileFinding = (): Finding => ({
  code: 'X_ROADMAP_FILE_MISSING',
  cause: `${ROADMAP_FILE} does not exist, so no milestone status or shipped artifact can be checked`,
  fix: `git checkout -- ${ROADMAP_FILE}`,
  docs: docs('X_ROADMAP_FILE_MISSING'),
  at: ROADMAP_FILE,
});

const missingStatusFinding = (n: number): Finding => ({
  code: 'X_ROADMAP_STATUS_MISSING',
  cause: `milestone ${n} has no row in the milestone table, or its row's status cell holds neither ${STATUS_MARK.shipped} nor ${STATUS_MARK['in-progress']}`,
  fix: `edit ${ROADMAP_FILE}: put "${STATUS_MARK.shipped}" or "${STATUS_MARK['in-progress']}" in the second cell of the row starting "| ${n} |", then: bun run scripts/roadmap.ts --json`,
  docs: docs('X_ROADMAP_STATUS_MISSING'),
  at: ROADMAP_FILE,
});

const unverifiedFinding = (row: MilestoneRow, missing: readonly string[]): Finding => ({
  code: 'X_ROADMAP_MILESTONE_UNVERIFIED',
  cause: `milestone ${row.n} ("${row.title}") is marked ${STATUS_MARK.shipped} but ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist`,
  fix: `git checkout -- ${missing.join(' ')} — or edit ${ROADMAP_FILE} and put "${STATUS_MARK['in-progress']}" in the status cell of the row starting "| ${row.n} |"`,
  docs: docs('X_ROADMAP_MILESTONE_UNVERIFIED'),
  at: ROADMAP_FILE,
});

/** Each milestone's "Done when" as a build error rather than a sentence nobody re-reads. */
export const checkRoadmap: HostCheck = async (root) => {
  const path = join(root, ROADMAP_FILE);
  if (!existsSync(path)) return [missingFileFinding()];
  const markdown = await Bun.file(path).text();
  const findings: Finding[] = [];
  for (const n of MILESTONE_NUMBERS) {
    const row = milestoneRow(markdown, n);
    if (row === undefined) {
      findings.push(missingStatusFinding(n));
      continue;
    }
    if (row.status !== 'shipped') continue;
    const missing = (REQUIRED_ARTIFACTS[n] ?? []).filter((rel) => !existsSync(join(root, rel)));
    if (missing.length > 0) findings.push(unverifiedFinding(row, missing));
  }
  return findings;
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await checkRoadmap(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: 'roadmap',
      summary:
        findings.length === 0
          ? `${MILESTONE_NUMBERS.length} milestones, every status marked and every shipped artifact present`
          : `${findings.length} roadmap finding(s) across ${MILESTONE_NUMBERS.length} milestones`,
      findings,
      data: { file: ROADMAP_FILE, milestones: MILESTONE_NUMBERS },
    },
    args.json,
  );
}
