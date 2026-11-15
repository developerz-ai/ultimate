// 31.29.0: the chart's migrate Job orders every rollout under any applier — a Helm hook, an Argo CD
// Sync hook in wave -1 (no longer the PreSync Argo mapped the Helm hook to), and named by its spec
// so an applier that ignores hooks gets a new Job per image. The Job, still exactly the old
// template, is replaced whole; `docker/README.md`'s two rows move where they stand.

import { CHART_FILE } from '../generate-chart-alerts';
import { names } from '../templates/naming';
import { helmMigrateFile, MIGRATE_JOB_PATH } from '../templates/scaffold-helm-migrate';
import { chartName } from './chart-dashboard';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults, readText } from './engine-edits';
import { MIGRATE_JOB_31_28_LINES } from './migrate-job-stock';

const README = 'docker/README.md';

export const MIGRATE_README_EDITS: readonly SnippetEdit[] = [
  {
    from: '| Kubernetes | an `initContainer` or a `Job` on the same image with `ROLE=migrate` |',
    to: "| Kubernetes | the chart's one `migrate` Job on the same image (`docker/helm`), ordered before every role — never a per-pod `initContainer` |",
    optional: true,
  },
  {
    from: '| Job | release | `ROLE=migrate`, a `pre-install,pre-upgrade` hook — it runs to completion first |',
    to: '| Job | release | `ROLE=migrate`, run to completion first: a `pre-install,pre-upgrade,pre-rollback` hook, an Argo CD `Sync` hook in wave -1, and named by its spec so any other applier gets a new Job per image |',
    optional: true,
  },
];

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** Today's Job when the app's is still the old template exactly; an edited one is reported. */
async function job(app: CodemodApp, chart: string): Promise<CodemodResult> {
  const file = await readText(app, MIGRATE_JOB_PATH);
  const next = String(helmMigrateFile(names(chart)).contents);
  if (file === undefined || file.text === next) return NOTHING;
  const stock = `${MIGRATE_JOB_31_28_LINES.map((line) => line.replaceAll('<APP>', chart)).join('\n')}\n`;
  if (file.text === stock) {
    await app.write(MIGRATE_JOB_PATH, file.restore(next));
    return { changed: [MIGRATE_JOB_PATH], skipped: [] };
  }
  return {
    changed: [],
    skipped: [
      {
        path: MIGRATE_JOB_PATH,
        reason:
          "the app's migrate Job is its own, so the ordering annotations and the spec-derived name were not written: the diff is the template's change, to make by hand",
        diff: unifiedDiff(MIGRATE_JOB_PATH, stock, next),
      },
    ],
  };
}

export const codemod: Codemod = {
  id: 'migrate-job-ordered',
  since: '31.29.0',
  summary: `${MIGRATE_JOB_PATH} orders every rollout under helm, Argo CD and a hook-blind applier alike`,
  async run(app) {
    const chart = chartName((await readText(app, CHART_FILE))?.text ?? '');
    return mergeResults([
      chart === undefined ? NOTHING : await job(app, chart),
      await editSnippets(app, README, MIGRATE_README_EDITS),
    ]);
  },
};
