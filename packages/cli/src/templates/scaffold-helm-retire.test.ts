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
 * died first (CI, 2026-10-07). Each test renders once; the scaffold's chart is written once.
 *
 * Awaited, never `Bun.spawnSync`. Inside a `bun test --parallel` worker the synchronous wait missed
 * its child's exit: run 37882529833 got exit 0 and EMPTY stdout back at exactly 30000 ms — helm had
 * rendered and exited, and only the timeout woke the wait — and five runs on 2026-10-09 never woke
 * at all, so the worker sat until the `unit` step's 480 s deadline killed it, with no helm left
 * running to kill. A synchronous wait also holds the event loop, so this file's own timeout could
 * not fire either. Awaited, the child keeps its own deadline (SIGKILL, so nothing it traps can
 * stretch it), and the test's timeout stays live behind it. Nothing here touches the network: the
 * charts have no dependencies and `--kube-version` stands in for a cluster.
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

let scaffolded: Promise<string> | undefined;

/** `x new`'s chart, written once per process: three tests read it and none changes it. */
function scaffoldChart(): Promise<string> {
  scaffolded ??= (async () => {
    for (const file of helmFiles(names('my-app'))) {
      await Bun.write(join(SCAFFOLD, file.path), file.contents);
    }
    return join(SCAFFOLD, 'docker', 'helm');
  })();
  return scaffolded;
}

/** Each Deployment by role, `<release>-<chart>-<role>` cut down to the role. */
async function render(chart: string, extra: readonly string[]): Promise<Map<string, Deployment>> {
  const child = Bun.spawn(
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
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: HELM_RENDER_MS,
      killSignal: 'SIGKILL',
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  // The exit, not the pipes' EOF, ends the wait: a pipe a stray grandchild still holds open would
  // keep the deadline from ever being reported.
  const code = await child.exited;
  if (code !== 0) {
    const how =
      child.signalCode === 'SIGKILL'
        ? `killed after its ${HELM_RENDER_MS} ms deadline`
        : (child.signalCode ?? `exit ${code}`);
    const said = await Promise.race([stderr, Bun.sleep(1_000).then(() => '(stderr still open)')]);
    return expect.unreachable(`helm template ${chart} (${how}): ${said}`);
  }
  const parsed: unknown = Bun.YAML.parse(await stdout);
  if (parsed === null)
    return expect.unreachable(`helm template ${chart} printed nothing: ${await stderr}`);
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
        const worker = (await render(chart, [])).get('worker');
        expect(preStopOf(worker)).toBeUndefined();
        expect(worker?.spec.template.spec.terminationGracePeriodSeconds).toBe(35);
      },
      TEST_MS,
    );

    test(
      `${which}: set, the worker sends PID 1 the retire signal and waits it out`,
      async () => {
        const chart = which === 'framework' ? FRAMEWORK : await scaffoldChart();
        const rendered = await render(chart, ['--set', 'roles.worker.retireSeconds=7200']);
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

    test(
      `${which}: drain.workerDeadlineSeconds sizes the worker's grace alone`,
      async () => {
        const chart = which === 'framework' ? FRAMEWORK : await scaffoldChart();
        const rendered = await render(chart, [
          '--set',
          'drain.workerDeadlineSeconds=7500',
          '--set',
          'roles.worker.retireSeconds=7200',
        ]);
        // The worker's budget replaces the 25 s one, and the retire still adds to it.
        expect(rendered.get('worker')?.spec.template.spec.terminationGracePeriodSeconds).toBe(
          7500 + 10 + 7200,
        );
        expect(rendered.get('web')?.spec.template.spec.terminationGracePeriodSeconds).toBe(45);
      },
      TEST_MS,
    );
  }
});
