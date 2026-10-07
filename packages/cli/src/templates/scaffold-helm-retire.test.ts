// The worker retire in both charts — the framework's (`docker/helm/`) and the one `x new` writes:
// `roles.worker.retireSeconds` > 0 gives the worker a `preStop` that sends PID 1 SIGUSR2 and waits
// for it to exit (`packages/cli/src/serve-retire.ts`), and adds those seconds to its grace period,
// which the kubelet counts the `preStop` against. Off (0) by default. Rendered with `helm template`
// when a helm binary is on PATH (CI's ubuntu runners ship one).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { RETIRE_SIGNAL } from '../serve-retire';
import { names } from './naming';
import { helmFiles } from './scaffold-helm';

const HELM = Bun.which('helm');
/**
 * One `helm template` child's budget, and the test's own deadline derived from it: a cold runner's
 * first render took over Bun's default 5 s while the child itself was allowed 30 s, so the TEST
 * died first (CI, 2026-10-07). Each test renders at most twice, plus the scaffold's chart write.
 */
const HELM_RENDER_MS = 30_000;
const TEST_MS = 2 * HELM_RENDER_MS + 5_000;
const FRAMEWORK = join(import.meta.dir, '..', '..', '..', '..', 'docker', 'helm');
const SCAFFOLD = mkdtempSync(join(tmpdir(), 'x-helm-retire-'));

afterAll(() => {
  rmSync(SCAFFOLD, { recursive: true, force: true });
});

interface Container {
  readonly lifecycle?: { readonly preStop?: { readonly exec?: { readonly command?: string[] } } };
}
interface Deployment {
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly template: {
      readonly spec: {
        readonly terminationGracePeriodSeconds?: number;
        readonly containers: readonly Container[];
      };
    };
  };
}

async function scaffoldChart(): Promise<string> {
  for (const file of helmFiles(names('my-app'))) {
    await Bun.write(join(SCAFFOLD, file.path), file.contents);
  }
  return join(SCAFFOLD, 'docker', 'helm');
}

/** Each Deployment by role, `<release>-<chart>-<role>` cut down to the role. */
function render(chart: string, extra: readonly string[]): Map<string, Deployment> {
  const result = Bun.spawnSync(
    [
      HELM ?? 'helm',
      'template',
      'app',
      chart,
      '--kube-version',
      '1.30.0',
      '--show-only',
      'templates/deployments.yaml',
      '--set-string',
      'image.repository=registry.example.com/app',
      ...extra,
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: HELM_RENDER_MS },
  );
  if (result.exitCode !== 0) return expect.unreachable(`helm: ${result.stderr.toString()}`);
  const parsed: unknown = Bun.YAML.parse(result.stdout.toString());
  const docs = (Array.isArray(parsed) ? parsed : [parsed]) as Deployment[];
  return new Map(docs.map((doc) => [doc.metadata.name.split('-').at(-1) ?? '', doc]));
}

const preStopOf = (doc: Deployment | undefined): readonly string[] | undefined =>
  doc?.spec.template.spec.containers[0]?.lifecycle?.preStop?.exec?.command;

describe.skipIf(HELM === null)('unit · roles.worker.retireSeconds, in both charts', () => {
  for (const which of ['framework', 'scaffold'] as const) {
    test(
      `${which}: off by default — no retire preStop, the drain-only grace`,
      async () => {
        const chart = which === 'framework' ? FRAMEWORK : await scaffoldChart();
        const worker = render(chart, []).get('worker');
        expect(preStopOf(worker)).toBeUndefined();
        expect(worker?.spec.template.spec.terminationGracePeriodSeconds).toBe(35);
      },
      TEST_MS,
    );

    test(
      `${which}: set, the worker sends PID 1 the retire signal and waits it out`,
      async () => {
        const chart = which === 'framework' ? FRAMEWORK : await scaffoldChart();
        const rendered = render(chart, ['--set', 'roles.worker.retireSeconds=7200']);
        const worker = rendered.get('worker');
        const command = preStopOf(worker);
        expect(command?.[0]).toBe('bun');
        expect(command?.join(' ')).toContain(`process.kill(1, '${RETIRE_SIGNAL}')`);
        expect(command?.join(' ')).toContain('process.kill(1, 0)');
        expect(worker?.spec.template.spec.terminationGracePeriodSeconds).toBe(7200 + 35);
        // The other roles are untouched: the retire is the worker's alone.
        expect(preStopOf(rendered.get('scheduler'))).toBeUndefined();
        expect(rendered.get('web')?.spec.template.spec.terminationGracePeriodSeconds).toBe(45);
      },
      TEST_MS,
    );
  }
});
