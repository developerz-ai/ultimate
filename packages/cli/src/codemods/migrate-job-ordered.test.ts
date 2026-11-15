// The migrate-job-ordered codemod over a chart `x new` wrote through 31.28: the Job still exactly
// the old template is replaced by today's (an Argo CD Sync hook, named by its image); an edited one
// is left whole and reported with the change as a diff; a second run changes nothing.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates/naming';
import { containerFiles } from '../templates/scaffold-container';
import { helmFiles } from '../templates/scaffold-helm';
import { helmMigrateFile, MIGRATE_JOB_PATH } from '../templates/scaffold-helm-migrate';
import { memoryCodemodApp } from './codemod';
import { codemod, MIGRATE_README_EDITS, MIGRATE_VALUES_EDITS } from './migrate-job-ordered';
import { MIGRATE_JOB_31_28_LINES } from './migrate-job-stock';

const README = 'docker/README.md';
const OLD_ROW =
  '| Kubernetes | an `initContainer` or a `Job` on the same image with `ROLE=migrate` |';

const stock = (chart: string): string =>
  `${MIGRATE_JOB_31_28_LINES.map((line) => line.replaceAll('<APP>', chart)).join('\n')}\n`;

const today = (chart: string): string => String(helmMigrateFile(names(chart)).contents);

const VALUES = 'docker/helm/values.yaml';
const OLD_VALUES = 'migrate:\n  enabled: true\n  backoffLimit: 1\n  resources: {}\n';

const app = (job: string, chart = 'shop') =>
  memoryCodemodApp({
    'docker/helm/Chart.yaml': `apiVersion: v2\nname: ${chart}\nversion: 0.1.0\n`,
    [MIGRATE_JOB_PATH]: job,
    [VALUES]: OLD_VALUES,
    [README]: `| Platform | Where |\n|---|---|\n${OLD_ROW}\n`,
  });

describe('unit · migrate-job-ordered', () => {
  test('the old template is replaced whole by today`s, and the README row follows', async () => {
    const shop = app(stock('shop'));
    const result = await codemod.run(shop);
    expect(result.skipped).toEqual([]);
    expect(result.changed.sort()).toEqual([README, MIGRATE_JOB_PATH, VALUES].sort());
    expect(shop.files[VALUES]).toContain('  ttlSecondsAfterFinished: 86400');
    expect(shop.files[MIGRATE_JOB_PATH]).toBe(today('shop'));
    expect(shop.files[MIGRATE_JOB_PATH]).toContain('argocd.argoproj.io/hook: Sync');
    expect(shop.files[README]).not.toContain('initContainer` or a');
  });

  test('each README row lands as x new writes it today', () => {
    const readme = String(
      containerFiles(names('shop')).find((file) => file.path === README)?.contents ?? '',
    );
    for (const edit of MIGRATE_README_EDITS) expect(readme).toContain(edit.to);
  });

  test('the values line lands as x new writes it today', () => {
    const values = String(helmFiles(names('shop')).find((file) => file.path === VALUES)?.contents);
    for (const edit of MIGRATE_VALUES_EDITS) expect(values).toContain(edit.to);
  });

  test('the summary names the fixed-name Job a cluster keeps from before', () => {
    expect(codemod.summary).toContain('kubectl delete job <release>-migrate');
  });

  test('a second run changes nothing', async () => {
    const shop = app(stock('shop'));
    await codemod.run(shop);
    expect(await codemod.run(shop)).toEqual({ changed: [], skipped: [] });
  });

  test('the stock text is what x new wrote, so a fresh 31.28 chart is recognised', () => {
    // Frozen: the bytes of the template 31.28.x shipped (verified equal to a tracked app's chart
    // when this codemod was written). A changed line is a stock no app holds.
    const hash = new Bun.CryptoHasher('sha256').update(MIGRATE_JOB_31_28_LINES.join('\n'));
    expect(hash.digest('hex')).toBe(
      '27448abec34832725dae734a2b30f8cd7c6c241036ec1c9922c5b1bdc4c9666c',
    );
    expect(stock('shop')).toContain('{{ include "shop.fullname" . }}-migrate\n');
    expect(stock('shop')).toContain('helm.sh/hook-delete-policy: before-hook-creation\n');
    expect(stock('shop')).not.toBe(today('shop'));
  });

  test('a Job the app edited is left whole and reported with the template`s change', async () => {
    const edited = stock('shop').replace(
      'backoffLimit: {{',
      'activeDeadlineSeconds: 600\n  backoffLimit: {{',
    );
    const shop = app(edited);
    const result = await codemod.run(shop);
    expect(shop.files[MIGRATE_JOB_PATH]).toBe(edited);
    expect(result.skipped.map((skip) => skip.path)).toEqual([MIGRATE_JOB_PATH]);
    expect(result.skipped[0]?.diff).toContain('+    argocd.argoproj.io/hook: Sync');
  });

  test('an app with no chart gets the README row and nothing else', async () => {
    const bare = memoryCodemodApp({ [README]: OLD_ROW });
    expect(await codemod.run(bare)).toEqual({ changed: [README], skipped: [] });
    const none = memoryCodemodApp({});
    expect(await codemod.run(none)).toEqual({ changed: [], skipped: [] });
  });
});
