// The chart `x new` writes, held to the three things a rolling restart depends on: a pod is given
// time to boot before liveness counts, time to drain before SIGKILL, and a worker autoscaler that
// reads the queue's ONE backlog rather than N copies of it. No helm binary is assumed here, so the
// assertions read the templates; `.github/workflows/ci.yml`'s `container` job renders the
// framework's own chart, and its `deploy-proof` job installs this one.

import { describe, expect, test } from 'bun:test';
import { drainDeadlineMs } from '@ultimat3/core';
import { names } from './naming';
import { helmFiles } from './scaffold-helm';

const APP = names('my-app');

const fileAt = (path: string): string => {
  const found = helmFiles(APP).find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`no generated ${path}`);
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

const values = (): Record<string, unknown> =>
  Bun.YAML.parse(fileAt('docker/helm/values.yaml')) as Record<string, unknown>;

/**
 * `READINESS_GRACE_DEFAULT_MS` in `packages/core/src/lifecycle-grace.ts`, the grace a non-local
 * process holds `/readyz` at 503 before closing its listener. Restated rather than imported
 * because core's barrel does not export it; the day it does, import it and delete this line.
 */
const READINESS_GRACE_DEFAULT_MS = 5000;

describe('unit · the scaffolded chart boots, drains and scales honestly', () => {
  test('every role that probes also has a startupProbe, 30 × 5s', () => {
    const helpers = fileAt('docker/helm/templates/_helpers.tpl');
    // Two branches take a liveness probe — the HTTP roles and the scrape-only ones — and a liveness
    // probe counting from container start restarts a pod still building its islands.
    const liveness = helpers.match(/livenessProbe:/g)?.length ?? 0;
    const startup =
      helpers.match(
        /startupProbe:\n\s+httpGet:[^\n]+\n\s+periodSeconds: 5\n\s+failureThreshold: 30/g,
      )?.length ?? 0;
    expect(liveness).toBe(2);
    expect(startup).toBe(liveness);
  });

  test('the preStop sleep renders only where the API server knows the field', () => {
    const helpers = fileAt('docker/helm/templates/_helpers.tpl');
    expect(helpers).toContain('semverCompare ">=1.30-0" $root.Capabilities.KubeVersion.Version');
    expect(helpers).toContain(
      'sleep: { seconds: {{ $root.Values.drain.preStopSleepSeconds | int }} }',
    );
    const drain = values()['drain'] as { preStopSleepSeconds?: number } | undefined;
    expect(drain?.preStopSleepSeconds).toBe(5);
  });

  test('terminationGracePeriodSeconds covers preStop + readiness grace + drain deadline', () => {
    const deployments = fileAt('docker/helm/templates/deployments.yaml');
    const grace = Number(/terminationGracePeriodSeconds: (\d+)/.exec(deployments)?.[1] ?? 0);
    const drain = values()['drain'] as { preStopSleepSeconds?: number } | undefined;
    const needed =
      (drain?.preStopSleepSeconds ?? 0) +
      READINESS_GRACE_DEFAULT_MS / 1000 +
      drainDeadlineMs() / 1000;
    expect(needed).toBe(35);
    expect(grace).toBeGreaterThanOrEqual(needed);
  });

  test('the worker scales on an External queue_depth, and a stray type fails the render', () => {
    const roles = values()['roles'] as Record<string, { autoscaling?: Record<string, unknown> }>;
    expect(roles['worker']?.autoscaling?.['type']).toBe('External');
    expect(roles['worker']?.autoscaling?.['metric']).toBe('queue_depth');
    // rps and open sockets are per-pod facts: those two stay Pods (the default).
    expect(roles['web']?.autoscaling?.['type']).toBeUndefined();
    expect(roles['sync']?.autoscaling?.['type']).toBeUndefined();
    const hpa = fileAt('docker/helm/templates/hpa.yaml');
    expect(hpa).toContain('- type: External\n      external:');
    expect(hpa).toContain('- type: Pods\n      pods:');
    expect(hpa).toContain('(list "Pods" "External")');
    expect(hpa).toContain('fail (printf');
  });

  test('the migrate hook names no ServiceAccount the chart would create after it', () => {
    // A pre-install hook runs before the chart's ordinary objects exist, so a Job naming one of
    // them is refused by admission and a first install waits out its timeout. This chart creates
    // no ServiceAccount, and the Job must not name one.
    for (const file of helmFiles(APP)) {
      if (typeof file.contents !== 'string') continue;
      expect([file.path, file.contents.includes('kind: ServiceAccount')]).toEqual([
        file.path,
        false,
      ]);
    }
    expect(fileAt('docker/helm/templates/migrate-job.yaml')).not.toContain('serviceAccountName');
  });

  // Every role boots through the same server, which builds the app's islands before any role
  // starts: ~325 MiB measured on a scaffolded app as ROLE=scheduler, OOMKilled at 256Mi forever.
  test('no role, and not the migrate Job, is limited below the boot floor of 512Mi', () => {
    const toMi = (limit: string): number =>
      limit.endsWith('Gi') ? Number(limit.slice(0, -2)) * 1024 : Number(limit.slice(0, -2));
    const parsed = values() as {
      roles: Record<string, { resources: { limits: { memory: string } } }>;
      migrate: { resources: { limits: { memory: string } } };
    };
    const limits = [
      ...Object.entries(parsed.roles).map(([role, cfg]) => [role, cfg.resources.limits.memory]),
      ['migrate', parsed.migrate.resources.limits.memory],
    ] as const;
    expect(limits.length).toBe(6);
    for (const [role, memory] of limits) expect([role, toMi(memory) >= 512]).toEqual([role, true]);
  });

  test('a release named after the app is not stuttered into my-app-my-app', () => {
    // `x deploy --method helm` names the release after the app, so helm create's rule applies: a
    // release that already contains the chart name is the full name on its own.
    const helpers = fileAt('docker/helm/templates/_helpers.tpl');
    expect(helpers).toContain('if contains $name .Release.Name');
  });

  // A sync pod on a real database with no NATS and no replicator is refused at boot
  // (X_REALTIME_TOPOLOGY), and a fresh chart has neither — so sync ships OFF, with the recipe.
  test('sync ships off, and the comment beside it names what enabling it takes', () => {
    const roles = values()['roles'] as Record<string, { enabled?: boolean }>;
    expect(roles['sync']?.enabled).toBe(false);
    const text = fileAt('docker/helm/values.yaml');
    for (const needed of ['NATS_URL', 'replicator', 'wal_level=logical', 'X_REALTIME_TOPOLOGY']) {
      expect(text).toContain(needed);
    }
  });
});
