// docker/helm, held to what a zero-downtime rollout needs from it: every role says when it is Ready
// (so a rollout cannot replace old workers with new ones that crash late in boot), a new pod has to
// STAY ready before it counts, and each role's grace period is derived from the drain budget it
// actually runs — never one literal that a raised `drain.deadlineMs` silently outgrows.
//
// Rendered with `helm template` when a helm binary is on PATH (CI's ubuntu runners ship one); the
// values-vs-core agreement below needs none and always runs.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { DRAIN_DEADLINE_DEFAULT_MS, READINESS_GRACE_DEFAULT_MS } from '@ultimat3/core';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const CHART = join(repoRoot(), 'docker', 'helm');
const HELM = Bun.which('helm');

interface Probe {
  readonly httpGet?: { readonly path?: string; readonly port?: string };
}

interface Deployment {
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly minReadySeconds?: number;
    readonly strategy: {
      readonly type: string;
      readonly rollingUpdate?: { readonly maxUnavailable?: number };
    };
    readonly template: {
      readonly spec: {
        readonly terminationGracePeriodSeconds?: number;
        readonly containers: readonly { readonly readinessProbe?: Probe }[];
      };
    };
  };
}

/** Every role on, so no Deployment is missing from the assertions below. */
const ALL_ROLES = ['--set', 'roles.sync.enabled=true', '--set', 'roles.replicator.enabled=true'];

/** One render's deadline, racing the child and its pipes. A render alone measures ~1-4 s. */
const RENDER_DEADLINE_MS = 30_000;

/**
 * One `helm template` render, AWAITED with a deadline that races the child and its pipes. Never
 * `Bun.spawnSync`: a synchronous wait holds the test worker's only thread, so a render that does
 * not come back is a worker neither the spawn's own timeout nor this file's 180 s budget can end —
 * gate unit-1 lost its whole first batch that way (#851): 68 of its 69 files passed while this
 * file never returned, batches 2-12 never started, and the step died at its deadline. SIGKILL,
 * because helm's install path traps SIGTERM and keeps running (scaffold-helm-retire.test.ts).
 *
 * The pipes are read through READERS this function retains, never `new Response(stream).text()`:
 * a Response body consumer takes the stream's reader lock, so the deadline branch's `cancel()`
 * would reject against the lock it holds itself and the pending reads would survive the kill — a
 * child that retains stdout/stderr (a helm descendant past the fork) left both pending, forever.
 * Cancelling the RETAINED reader stops its own read and releases the lock.
 */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

async function render(
  kubeVersion: string,
  extra: readonly string[] = [],
): Promise<Map<string, Deployment>> {
  const child = Bun.spawn(
    [
      HELM ?? 'helm',
      'template',
      'app',
      CHART,
      '--kube-version',
      kubeVersion,
      '--show-only',
      'templates/deployments.yaml',
      ...ALL_ROLES,
      ...extra,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), RENDER_DEADLINE_MS);
  });
  const outReader = child.stdout.getReader();
  const errReader = child.stderr.getReader();
  const settled = await Promise.race([
    Promise.all([readAll(outReader), readAll(errReader), child.exited]),
    late,
  ]);
  clearTimeout(timer);
  if (settled === 'late') {
    child.kill('SIGKILL');
    await Promise.allSettled([outReader.cancel(), errReader.cancel()]);
    outReader.releaseLock();
    errReader.releaseLock();
    return expect.unreachable(
      `helm template ${kubeVersion} did not finish within ${RENDER_DEADLINE_MS} ms and was killed`,
    );
  }
  const [stdout, stderr, exitCode] = settled;
  if (exitCode !== 0) return expect.unreachable(`helm template: ${stderr}`);
  const parsed: unknown = Bun.YAML.parse(stdout);
  const docs = (Array.isArray(parsed) ? parsed : [parsed]) as Deployment[];
  return new Map(docs.map((doc) => [doc.metadata.name.replace('app-ultimate-', ''), doc]));
}

const graceOf = (deployments: Map<string, Deployment>): Record<string, number | undefined> =>
  Object.fromEntries(
    [...deployments].map(([role, doc]) => [
      role,
      doc.spec.template.spec.terminationGracePeriodSeconds,
    ]),
  );

describe('unit · the chart values agree with the framework defaults', () => {
  test('the drain budget and the readiness grace are core’s, in seconds', async () => {
    const values = Bun.YAML.parse(await Bun.file(join(CHART, 'values.yaml')).text()) as {
      drain?: Record<string, unknown>;
      minReadySeconds?: unknown;
    };
    expect(values.drain?.['deadlineSeconds']).toBe(DRAIN_DEADLINE_DEFAULT_MS / 1000);
    expect(values.drain?.['readinessGraceSeconds']).toBe(READINESS_GRACE_DEFAULT_MS / 1000);
    expect(values.drain?.['teardownMarginSeconds']).toBe(10);
    expect(values.minReadySeconds).toBe(10);
  });

  test('no Deployment carries a literal grace period any more', async () => {
    const text = await Bun.file(join(CHART, 'templates', 'deployments.yaml')).text();
    expect(text).not.toMatch(/terminationGracePeriodSeconds: \d/);
  });
});

describe.skipIf(HELM === null)('unit · docker/helm rendered', () => {
  test('every role has a readinessProbe on /readyz, worker and scheduler included', async () => {
    const deployments = await render('1.30.0');
    expect([...deployments.keys()].sort()).toEqual([
      'replicator',
      'scheduler',
      'sync',
      'web',
      'worker',
    ]);
    for (const [role, doc] of deployments) {
      const path = doc.spec.template.spec.containers[0]?.readinessProbe?.httpGet?.path;
      expect({ role, readyz: path?.startsWith('/readyz') }).toEqual({ role, readyz: true });
    }
  });

  test('a new pod must stay Ready for minReadySeconds before the rollout counts it', async () => {
    for (const [role, doc] of await render('1.30.0', ['--set', 'minReadySeconds=17'])) {
      expect({ role, min: doc.spec.minReadySeconds }).toEqual({ role, min: 17 });
    }
  });

  test('the grace period is derived per role: preStop + readiness grace where routed, + budget + margin', async () => {
    // web and sync: 5 preStop (1.30+) + 5 readiness grace + 25 drain + 10 teardown. The roles
    // nothing routes to drain with no grace (`lifecycleForRole`) and render no preStop.
    expect(graceOf(await render('1.30.0'))).toEqual({
      replicator: 35,
      scheduler: 35,
      sync: 45,
      web: 45,
      worker: 35,
    });
    // Below 1.30 no preStop sleep renders, so none is budgeted.
    expect(graceOf(await render('1.29.0'))).toMatchObject({ web: 40, worker: 35 });
  });

  test('raising the drain budget raises every role’s grace period with it', async () => {
    const raised = graceOf(await render('1.30.0', ['--set', 'drain.deadlineSeconds=600']));
    expect(raised).toMatchObject({ web: 620, worker: 610, scheduler: 610 });
  });

  test('every rolling role keeps maxUnavailable: 0', async () => {
    for (const [role, doc] of await render('1.30.0')) {
      if (role === 'replicator') continue;
      expect({ role, unavailable: doc.spec.strategy.rollingUpdate?.maxUnavailable }).toEqual({
        role,
        unavailable: 0,
      });
    }
  });
});
