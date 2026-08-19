// `diffManifest` — the contract diff `x verify` gates on. This file is the orchestrator: one
// classifier per section, in `diff-*.ts` beside it, and every section of `Manifest` reaches
// exactly one of them.
//
// `x verify` fails on a breaking change without a major version bump. Additive and internal
// changes never fail, which is what makes the gate credible enough to leave on. The three kinds
// are defined in `diff-change.ts`.
//
// EVERY section is read. Two of them were not until 2026-08 — `tasks` and `errorCodes`, alongside
// ten unclassified fields — so deleting every scheduled task and every error code reported
// `[{ kind: 'internal', path: 'buildId' }]` and passed. `diff.test.ts` walks `ARRAY_SECTIONS` and
// fails on a section nothing here classifies.

import type { ManifestChange } from './diff-change';
import { diffNamedSet } from './diff-change';
import { diffEntities } from './diff-entities';
import { diffActions, diffQueries } from './diff-operations';
import { diffErrorCodes, diffPolicies } from './diff-registries';
import { diffRoutes } from './diff-routes';
import { diffJobs, diffTasks } from './diff-work';
import type { Manifest } from './schema';

export type { ChangeKind, ManifestChange } from './diff-change';

export interface ManifestDiff {
  readonly changes: readonly ManifestChange[];
  readonly breaking: readonly ManifestChange[];
  readonly additive: readonly ManifestChange[];
  readonly internal: readonly ManifestChange[];
  readonly hasBreaking: boolean;
}

export function diffManifest(before: Manifest, after: Manifest): ManifestDiff {
  const changes: ManifestChange[] = [];

  if (before.manifestVersion !== after.manifestVersion) {
    changes.push({
      kind: 'breaking',
      path: 'manifestVersion',
      detail: `manifest shape ${before.manifestVersion} -> ${after.manifestVersion}`,
    });
  }
  if (before.buildId !== after.buildId) {
    changes.push({ kind: 'internal', path: 'buildId', detail: 'content changed' });
  }

  changes.push(...diffActions(before.actions, after.actions));
  changes.push(...diffQueries(before.queries, after.queries));
  changes.push(...diffRoutes(before.routes, after.routes));
  changes.push(...diffJobs(before.jobs, after.jobs));
  changes.push(...diffTasks(before.tasks, after.tasks));
  changes.push(...diffEntities(before.entities, after.entities));
  changes.push(...diffPolicies(before.policies, after.policies));
  changes.push(...diffErrorCodes(before.errorCodes, after.errorCodes));
  changes.push(...diffNamedSet('permissions', before.permissions, after.permissions));
  changes.push(...diffNamedSet('locales', before.locales, after.locales, 'additive'));

  const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const breaking = sorted.filter((c) => c.kind === 'breaking');
  return {
    changes: sorted,
    breaking,
    additive: sorted.filter((c) => c.kind === 'additive'),
    internal: sorted.filter((c) => c.kind === 'internal'),
    hasBreaking: breaking.length > 0,
  };
}

/** One line per change, `--json`-free, for a terminal summary. */
export function formatDiff(diff: ManifestDiff): readonly string[] {
  return diff.changes.map((c: ManifestChange) => `${c.kind.padEnd(8)} ${c.path}: ${c.detail}`);
}
