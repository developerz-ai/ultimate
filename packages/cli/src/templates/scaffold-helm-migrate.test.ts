// The deploy order, in both charts — the framework's (`docker/helm/`) and the one `x new` writes:
// the migrate Job runs before any role under plain Helm (a pre-install/pre-upgrade hook), under
// Argo CD (a Sync hook in a wave before the roles'), and is still a valid ordinary object for an
// applier that ignores both — its name follows its image, so a new image is a new Job, never an
// immutable-field refusal. Rendered with `helm template` when a helm binary is on PATH (CI's
// ubuntu runners ship one); the template assertions need none.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no temp-directory primitive.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no temp-directory primitive.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { names } from './naming';
import { helmFiles } from './scaffold-helm';

setDefaultTimeout(60_000);

const FRAMEWORK = join(import.meta.dir, '..', '..', '..', '..', 'docker', 'helm');
const HELM = Bun.which('helm');

/** The scaffold's chart, written where helm can read it. */
const scaffold = mkdtempSync(join(tmpdir(), 'x-helm-migrate-'));
for (const file of helmFiles(names('ultimate'))) {
  await Bun.write(join(scaffold, file.path), file.contents);
}
const SCAFFOLD = join(scaffold, 'docker', 'helm');
afterAll(() => rmSync(scaffold, { recursive: true, force: true }));

const CHARTS: readonly (readonly [string, string])[] = [
  ['docker/helm', FRAMEWORK],
  ['x new', SCAFFOLD],
];

interface Doc {
  readonly kind: string;
  readonly metadata: { readonly name: string; readonly annotations?: Record<string, string> };
  readonly spec?: { readonly template?: { readonly spec?: { readonly initContainers?: unknown } } };
}

async function render(chart: string, extra: readonly string[] = []): Promise<readonly Doc[]> {
  const child = Bun.spawn(
    [HELM ?? 'helm', 'template', 'app', chart, '--set-string', 'image.tag=1.0.0', ...extra],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) return expect.unreachable(`helm template ${chart}: ${stderr}`);
  return stdout
    .split(/^---$/m)
    .map((part): unknown => Bun.YAML.parse(part))
    .filter((doc): doc is Doc => typeof doc === 'object' && doc !== null && 'kind' in doc);
}

const migrateJob = (docs: readonly Doc[]): Doc => {
  const jobs = docs.filter((doc) => doc.kind === 'Job');
  expect(jobs).toHaveLength(1);
  return jobs[0] ?? expect.unreachable('no migrate Job');
};

/** Argo CD's wave: its own annotation, 0 when absent. */
const wave = (doc: Doc): number =>
  Number(doc.metadata.annotations?.['argocd.argoproj.io/sync-wave'] ?? 0);

describe.skipIf(HELM === null)('unit · the migrate Job orders every rollout, rendered', () => {
  test.each(CHARTS)(
    '%s: a Helm hook before install, upgrade and rollback, and an Argo CD Sync hook',
    async (_, chart) => {
      const job = migrateJob(await render(chart));
      expect(job.metadata.annotations).toMatchObject({
        'helm.sh/hook': 'pre-install,pre-upgrade,pre-rollback',
        'argocd.argoproj.io/hook': 'Sync',
        'argocd.argoproj.io/sync-wave': '-1',
      });
    },
  );

  test.each(CHARTS)(
    '%s: every other object lands in a later Argo CD wave than the Job',
    async (_, chart) => {
      const docs = await render(chart, [
        '--set',
        'roles.sync.enabled=true',
        '--set',
        'roles.replicator.enabled=true',
      ]);
      const job = migrateJob(docs);
      const roles = docs.filter((doc) => doc.kind === 'Deployment');
      expect(roles.length).toBeGreaterThanOrEqual(5);
      for (const role of roles) {
        expect({ role: role.metadata.name, after: wave(role) > wave(job) }).toEqual({
          role: role.metadata.name,
          after: true,
        });
      }
      // The Job's own ServiceAccount, where the chart makes one, exists before the Job does.
      for (const account of docs.filter(
        (doc) => doc.kind === 'ServiceAccount' && doc.metadata.annotations,
      )) {
        expect(account.metadata.annotations?.['argocd.argoproj.io/hook']).toBe('Sync');
        expect(wave(account)).toBeLessThan(wave(job));
      }
    },
  );

  test.each(CHARTS)('%s: one mechanism — no role carries an init container', async (_, chart) => {
    const docs = await render(chart, [
      '--set',
      'roles.sync.enabled=true',
      '--set',
      'roles.replicator.enabled=true',
    ]);
    for (const role of docs.filter((doc) => doc.kind === 'Deployment')) {
      expect({ role: role.metadata.name, init: role.spec?.template?.spec?.initContainers }).toEqual(
        {
          role: role.metadata.name,
          init: undefined,
        },
      );
    }
  });

  test.each(CHARTS)(
    '%s: the Job is named by its image — a new image is a new Job',
    async (_, chart) => {
      const first = migrateJob(await render(chart)).metadata.name;
      const again = migrateJob(await render(chart)).metadata.name;
      const next = migrateJob(await render(chart, ['--set-string', 'image.tag=1.0.1'])).metadata
        .name;
      expect(first).toMatch(/^app-ultimate-migrate-[0-9a-f]{8}$/);
      expect(again).toBe(first);
      expect(next).not.toBe(first);
      expect(next.length).toBeLessThanOrEqual(63);
    },
  );

  test.each(CHARTS)(
    '%s: the name hashes no env value — an inline secret is never an oracle',
    async (_, chart) => {
      const name = async (value: string) =>
        migrateJob(await render(chart, ['--set-string', `env.SOME_TOKEN=${value}`])).metadata.name;
      expect(await name('aaaa')).toBe(await name('bbbb'));
      const resized = migrateJob(
        await render(chart, ['--set-string', 'migrate.resources.limits.memory=1Gi']),
      ).metadata.name;
      expect(resized).not.toBe(await name('aaaa'));
    },
  );

  test.each(CHARTS)(
    '%s: a finished Job is collected after a day, or after migrate.ttlSecondsAfterFinished',
    async (_, chart) => {
      const ttl = async (extra: readonly string[]) =>
        (migrateJob(await render(chart, extra)).spec as { ttlSecondsAfterFinished?: number })
          .ttlSecondsAfterFinished;
      expect(await ttl([])).toBe(86400);
      expect(await ttl(['--set', 'migrate.ttlSecondsAfterFinished=600'])).toBe(600);
      expect(await ttl(['--set', 'migrate.ttlSecondsAfterFinished=0'])).toBe(0);
    },
  );

  test.each(CHARTS)(
    '%s: the longest release name helm accepts (53) still renders a valid Job name',
    async (_, chart) => {
      const long = 'r'.repeat(53);
      const child = Bun.spawn(
        [HELM ?? 'helm', 'template', long, chart, '--show-only', 'templates/migrate-job.yaml'],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const name = /kind: Job\nmetadata:\n {2}name: (\S+)/.exec(out)?.[1] ?? '';
      expect(name).toMatch(/-migrate-[0-9a-f]{8}$/);
      expect(name.length).toBeLessThanOrEqual(63);
    },
  );
});
