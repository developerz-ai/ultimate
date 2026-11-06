// `x g chart-alerts`: what it writes into an app's existing chart, what it leaves alone, and what
// `--print` hands a rule loader outside Kubernetes.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, so a throwaway app root's lifetime is node:fs's.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { missingValueBlocks } from './generate-chart-alerts';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { names } from './templates';
import { helmFiles } from './templates/scaffold-helm';
import { alertRuleGroups, helmMonitoringFiles } from './templates/scaffold-helm-alerts';

const SM = 'docker/helm/templates/servicemonitor.yaml';
const RULES = 'docker/helm/templates/alert-rules.yaml';
const VALUES = 'docker/helm/values.yaml';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** An app whose chart predates the monitoring templates: `Chart.yaml` plus an old `values.yaml`. */
async function appWithChart(values = 'replicaCount: 1\nmetricsPort: 9090\n'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-chart-alerts-'));
  roots.push(root);
  await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
  await Bun.write(join(root, 'docker/helm/Chart.yaml'), 'apiVersion: v2\nname: shop\n');
  await Bun.write(join(root, VALUES), values);
  return root;
}

const run = (root: string, ...argv: string[]) =>
  generateCommand.run({
    args: parseArgs(['g', 'chart-alerts', ...argv], SPECS),
    cwd: root,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  } satisfies CommandContext);

const read = (root: string, path: string) => Bun.file(join(root, path)).text();

describe('unit · x g chart-alerts', () => {
  test('writes both templates for the chart Chart.yaml names, and both values blocks', async () => {
    const root = await appWithChart();
    const result = await run(root);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ files: [SM, RULES, VALUES], edits: [VALUES] });
    const expected = new Map(helmMonitoringFiles(names('shop')).map((f) => [f.path, f.contents]));
    expect(await read(root, SM)).toBe(expected.get(SM) as string);
    expect(await read(root, RULES)).toBe(expected.get(RULES) as string);
    expect(await read(root, RULES)).toContain('include "shop.fullname"');
    const values: unknown = Bun.YAML.parse(await read(root, VALUES));
    expect(values).toMatchObject({
      replicaCount: 1,
      serviceMonitor: { enabled: 'auto' },
      alerts: { enabled: 'auto', rules: {} },
    });
  });

  test('a second run writes nothing and says so', async () => {
    const root = await appWithChart();
    await run(root);
    const before = await read(root, VALUES);
    const result = await run(root);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ files: [], edits: [] });
    expect(result.summary).toBe('wrote 0 file(s) for chart-alerts shop');
    expect(await read(root, VALUES)).toBe(before);
  });

  test('a template the app already holds is kept; --force rewrites it', async () => {
    const root = await appWithChart();
    await Bun.write(join(root, SM), '# the app’s own\n');
    const kept = await run(root);
    expect(kept.data).toMatchObject({ files: [RULES, VALUES] });
    expect(await read(root, SM)).toBe('# the app’s own\n');
    await run(root, '--force');
    expect(await read(root, SM)).toContain('kind: ServiceMonitor');
  });

  test('a deliberate serviceMonitor block is honoured: only the alerts block is appended', async () => {
    const root = await appWithChart('serviceMonitor:\n  enabled: false\n');
    await run(root);
    const values: unknown = Bun.YAML.parse(await read(root, VALUES));
    expect(values).toMatchObject({
      serviceMonitor: { enabled: false },
      alerts: { enabled: 'auto' },
    });
  });

  test('--dry-run plans the same files and writes none', async () => {
    const root = await appWithChart();
    const result = await run(root, '--dry-run');
    expect(result.data).toMatchObject({ files: [SM, RULES, VALUES], dryRun: true });
    expect(await Bun.file(join(root, SM)).exists()).toBe(false);
    expect(await read(root, VALUES)).toBe('replicaCount: 1\nmetricsPort: 9090\n');
  });

  test('--print is the plain rule groups, and needs no chart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-chart-alerts-'));
    roots.push(root);
    await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
    const result = await run(root, '--print');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ rules: alertRuleGroups() });
    expect(result.lines?.join('\n')).toBe(alertRuleGroups().trimEnd());
  });

  test('no chart is X_CHART_MISSING, and its fix is the half that needs none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-chart-alerts-'));
    roots.push(root);
    await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
    const failure = (await run(root).catch((error: unknown) => error)) as Record<string, unknown>;
    expect(failure['code']).toBe('X_CHART_MISSING');
    expect(failure['fix']).toBe('x g chart-alerts --print --json');
  });

  test('a flag it does not read is refused, and --print on another generator too', async () => {
    const root = await appWithChart();
    const unread = (await run(root, '--live').catch((error: unknown) => error)) as {
      code: string;
    };
    expect(unread.code).toBe('X_CLI_BAD_FLAG');
    const named = (await run(root, 'shop').catch((error: unknown) => error)) as { fix: string };
    expect(named.fix).toBe('x g chart-alerts');
    const elsewhere = (await generateCommand
      .run({
        args: parseArgs(['g', 'route', 'posts', '--print'], SPECS),
        cwd: root,
        runner: exec,
        env: {},
        bunVersion: REQUIRED_BUN,
      })
      .catch((error: unknown) => error)) as { code: string; fix: string };
    expect(elsewhere.code).toBe('X_CLI_BAD_FLAG');
    expect(elsewhere.fix).toBe('x g chart-alerts --print');
  });
});

describe('unit · the values blocks are the scaffold’s own bytes', () => {
  test("an old values.yaml gains exactly the blocks x new's values.yaml carries", () => {
    const scaffold = helmFiles(names('shop')).find((file) => file.path === VALUES);
    const blocks = missingValueBlocks('replicaCount: 1\n');
    expect(scaffold?.contents).toContain(blocks);
    expect(missingValueBlocks(scaffold?.contents as string)).toBe('');
  });
});
