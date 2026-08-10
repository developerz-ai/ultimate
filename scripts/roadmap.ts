// Turns `docs/idea/14-roadmap.md` from prose into a gate step. Two rules, both decidable without
// running the demo app: (1) every milestone row carries a status marker — the table this file
// guards against shipped with zero, and a silent regression back to that state is exactly the bug
// a reader would not notice; (2) a milestone marked shipped still has every artifact its own
// "Ships" column names on disk — a status marker nobody checks is a claim, not a gate.
//
//   bun run scripts/roadmap.ts [--json]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, HostCheck } from '@ultimat3/cli';

export const ROADMAP_FILE = 'docs/idea/14-roadmap.md';

export type MilestoneStatus = 'shipped' | 'in-progress';

export const STATUS_MARK: Readonly<Record<MilestoneStatus, string>> = {
  shipped: '✅',
  'in-progress': '🚧',
};

export interface Milestone {
  readonly n: number;
  readonly title: string;
  readonly status: MilestoneStatus;
  /**
   * Repo-relative paths the milestone's own "Ships" column claims exist. Checked only once the
   * milestone is marked `shipped` — an `in-progress` milestone's artifacts are still landing, so
   * their absence is not yet a regression.
   */
  readonly requires: readonly string[];
}

/**
 * One row per roadmap milestone (`docs/idea/14-roadmap.md`), mirrored here because a markdown
 * table cannot assert anything about the filesystem on its own. `As of 2026-08`: milestones 0–10
 * ship the packages/commands their rows name; 11 ships its artifacts but not its two-platform
 * deploy proof, which needs real infrastructure — see "Open at 1.0.0" in the roadmap.
 */
export const MILESTONES: readonly Milestone[] = [
  {
    n: 0,
    title: 'Skeleton + error contract',
    status: 'shipped',
    requires: [
      'packages/core/src/index.ts',
      'packages/schema/src/index.ts',
      'scripts/boundaries.ts',
      'packages/cli/src/cmd-verify.ts',
    ],
  },
  {
    n: 1,
    title: 'HTTP + entity + policy',
    status: 'shipped',
    requires: [
      'packages/http/src/index.ts',
      'packages/entity/src/index.ts',
      'packages/policy/src/index.ts',
    ],
  },
  {
    n: 2,
    title: 'action + query + typed client',
    status: 'shipped',
    requires: [
      'packages/action/src/index.ts',
      'packages/query/src/index.ts',
      'packages/cli/src/app-openapi.ts',
    ],
  },
  {
    n: 3,
    title: 'Rendering + router + site/app split',
    status: 'shipped',
    requires: ['packages/render/src/index.ts', 'packages/cli/src/app-boundaries.ts'],
  },
  {
    n: 4,
    title: 'SEO + images + budgets',
    status: 'shipped',
    requires: ['packages/seo/src/index.ts', 'packages/cli/src/budgets.ts'],
  },
  {
    n: 5,
    title: 'Jobs + tasks + mail + storage + scheduler',
    status: 'shipped',
    requires: [
      'packages/jobs/src/index.ts',
      'packages/mail/src/index.ts',
      'packages/storage/src/index.ts',
    ],
  },
  // The reconnect benchmark left this row at 1.0.0: no number was ever measured, and a ✅ that
  // covered an unmeasured claim is exactly what this step exists to catch. It is now tracked under
  // "Open at 1.0.0" in the roadmap instead.
  {
    n: 6,
    title: 'Realtime tier 1-2',
    status: 'shipped',
    requires: ['packages/realtime/src/index.ts'],
  },
  {
    n: 7,
    title: 'Caching, four tiers, one tag graph',
    status: 'shipped',
    requires: ['packages/cache/src/index.ts'],
  },
  {
    n: 8,
    title: 'PWA + offline + version skew',
    status: 'shipped',
    requires: ['packages/pwa/src/index.ts'],
  },
  {
    n: 9,
    title: 'AI-first surface',
    status: 'shipped',
    requires: ['packages/ai/src/index.ts', 'packages/mcp/src/index.ts'],
  },
  {
    n: 10,
    title: 'Admin + generators + x new',
    status: 'shipped',
    requires: [
      'packages/admin/src/index.ts',
      'packages/create-ultimate/src/index.ts',
      'packages/cli/src/templates',
    ],
  },
  {
    n: 11,
    title: 'Deploy + docs + 1.0',
    status: 'in-progress',
    requires: [
      'docker/Dockerfile',
      'docker/docker-compose.dev.yml',
      'docker/docker-compose.prod.yml',
      'docker/helm',
      'packages/cli/src/cmd-build.ts',
      'wiki/Error-Codes.md',
      'CHANGELOG.md',
    ],
  },
];

/** The markdown row for milestone `n` — `| n | title | ships | done when |`, status prefixed. */
const rowFor = (markdown: string, n: number): string | undefined =>
  markdown.split('\n').find((line) => new RegExp(`^\\|\\s*${n}\\s*\\|`).test(line));

const missingStatusFinding = (m: Milestone): Finding => ({
  code: 'X_ROADMAP_STATUS_MISSING',
  cause: `milestone ${m.n} ("${m.title}") has no ${STATUS_MARK.shipped}/${STATUS_MARK['in-progress']} status marker in its row`,
  fix: `add "${STATUS_MARK[m.status]}" to milestone ${m.n}'s row in ${ROADMAP_FILE}`,
  docs: 'https://ultimate.dev/errors/X_ROADMAP_STATUS_MISSING',
  at: ROADMAP_FILE,
});

const unverifiedFinding = (m: Milestone, missing: readonly string[]): Finding => ({
  code: 'X_ROADMAP_MILESTONE_UNVERIFIED',
  cause: `milestone ${m.n} ("${m.title}") is marked ${STATUS_MARK.shipped} but ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist`,
  fix: `restore the missing path(s), or mark milestone ${m.n} "${STATUS_MARK['in-progress']}" in ${ROADMAP_FILE} until it does`,
  docs: 'https://ultimate.dev/errors/X_ROADMAP_MILESTONE_UNVERIFIED',
  at: ROADMAP_FILE,
});

/** Each milestone's "Done when" as a build error rather than a sentence nobody re-reads. */
export const checkRoadmap: HostCheck = async (root) => {
  const path = join(root, ROADMAP_FILE);
  if (!existsSync(path)) return [];
  const markdown = await Bun.file(path).text();
  const findings: Finding[] = [];
  for (const milestone of MILESTONES) {
    const row = rowFor(markdown, milestone.n);
    if (row === undefined || !row.includes(STATUS_MARK[milestone.status])) {
      findings.push(missingStatusFinding(milestone));
      continue;
    }
    if (milestone.status !== 'shipped') continue;
    const missing = milestone.requires.filter((rel) => !existsSync(join(root, rel)));
    if (missing.length > 0) findings.push(unverifiedFinding(milestone, missing));
  }
  return findings;
};
