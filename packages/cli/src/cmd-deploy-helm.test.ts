// `x deploy --method helm` waits for what it started and reports what helm said. Without `--wait`
// the command exited 0 the moment the API server accepted the objects; with helm's 5m default a
// long migrate hook failed the upgrade while its Job kept running; and the release was the literal
// `app` for every app, so two apps in one namespace were one release.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in these synchronous fixture helpers.
import { mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { deployCommand } from './cmd-deploy';
import { HELM_DEFAULT_TIMEOUT, readHelmTimeout, readRollout } from './cmd-deploy-helm';
import type { CommandContext } from './command';
import { parseArgs } from './parse';
import { SPECS } from './registry';

/** An app root whose `app.config.ts` exports `config` — named, or deliberately not. */
function appRoot(config = "{ name: 'shop-web' }"): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-deploy-helm-'));
  writeFileSync(join(dir, 'app.config.ts'), `export const config = ${config};\n`);
  return dir;
}

/** Records every argv and answers with `stdout`, as helm's `--output json` would. */
function helmRunner(stdout = '', code = 0) {
  const ran: string[][] = [];
  const runner: CommandContext['runner'] = async (command) => {
    ran.push([...command]);
    return { command, code, ok: code === 0, stdout, stderr: '', durationMs: 3 };
  };
  return { runner, ran };
}

const run = (argv: readonly string[], cwd: string, runner = helmRunner().runner) =>
  deployCommand.run({
    args: parseArgs(['deploy', '--image', 'ghcr.io/org/shop:1.2.3', ...argv], SPECS),
    cwd,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  });

/** The code a refusal carries, or a failure naming what came back instead. */
async function refusalCode(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    return isUltimateError(error) ? error.code : expect.unreachable('a non-Ultimate error');
  }
  return expect.unreachable('x deploy accepted what it must refuse');
}

describe('unit · x deploy --method helm waits, and names its release', () => {
  test('the upgrade waits for the rollout, under a 15m timeout, as the app it is', async () => {
    const { runner, ran } = helmRunner();
    const result = await run(['--method', 'helm'], appRoot(), runner);
    expect(result.ok).toBe(true);
    const argv = ran[0] ?? [];
    expect(argv.slice(0, 4)).toEqual(['helm', 'upgrade', '--install', 'shop-web']);
    expect(argv).toContain('--wait');
    expect(argv[argv.indexOf('--timeout') + 1]).toBe('15m');
    expect(argv).toContain('--timeout');
    expect(argv[argv.indexOf('--output') + 1]).toBe('json');
    expect(argv).toContain('--output');
    // No namespace flag means helm's own: the kube context's. Never a guessed `default`.
    expect(argv).not.toContain('--namespace');
    expect(HELM_DEFAULT_TIMEOUT).toBe('15m');
  });

  test('--namespace, --timeout and --release reach helm verbatim', async () => {
    const { runner, ran } = helmRunner();
    await run(
      ['--method', 'helm', '--namespace', 'prod', '--timeout', '30m', '--release', 'app'],
      appRoot(),
      runner,
    );
    const argv = ran[0] ?? [];
    expect(argv[3]).toBe('app');
    expect(argv[argv.indexOf('--namespace') + 1]).toBe('prod');
    expect(argv).toContain('--namespace');
    expect(argv[argv.indexOf('--timeout') + 1]).toBe('30m');
  });

  test('the dry run reports the release it resolved, which nobody typed', async () => {
    const result = await run(['--method', 'helm', '--dry-run'], appRoot());
    expect(result.data).toMatchObject({
      method: 'helm',
      helm: { release: 'shop-web', namespace: null, timeout: '15m' },
    });
  });

  test('the report carries helm’s own verdict and revision', async () => {
    const record = JSON.stringify({
      name: 'shop-web',
      namespace: 'prod',
      version: 7,
      info: { status: 'deployed' },
    });
    const { runner } = helmRunner(record);
    const result = await run(['--method', 'helm', '--namespace', 'prod'], appRoot(), runner);
    expect(result.data).toMatchObject({
      rollout: { release: 'shop-web', namespace: 'prod', revision: 7, status: 'deployed' },
    });
  });

  // The `fix:` is a line to paste, and an app root holding a space pasted back as two arguments —
  // `helm upgrade … /srv/my app/docker/helm` upgrades a chart at `/srv/my`.
  test('the rerun line quotes a path that would split in a shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x deploy $(helm) '));
    writeFileSync(join(root, 'app.config.ts'), "export const config = { name: 'shop-web' };\n");
    const { runner } = helmRunner('', 1);
    const result = await run(['--method', 'helm'], root, runner);
    const fix = result.findings?.[0]?.fix ?? '';
    expect(fix).toContain(`'${join(root, 'docker', 'helm')}'`);
    expect(fix).toStartWith('helm upgrade --install shop-web ');
  });

  test('a failed upgrade still reports what helm printed, beside X_DEPLOY_FAILED', async () => {
    const { runner } = helmRunner('', 1);
    const result = await run(['--method', 'helm'], appRoot(), runner);
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_DEPLOY_FAILED');
    expect(result.data).toMatchObject({ rollout: { status: 'unknown', revision: null } });
  });
});

describe('unit · what x deploy --method helm refuses before spawning anything', () => {
  test('a helm-only flag on the compose method is refused, never dropped', async () => {
    for (const flag of ['--namespace', '--timeout', '--release']) {
      const value = flag === '--timeout' ? '5m' : 'prod';
      expect(await refusalCode(run([flag, value], appRoot()))).toBe('X_CLI_BAD_FLAG');
    }
  });

  test('a timeout helm would reject is refused', () => {
    for (const bad of ['15', '0s', '15 m', 'm', '-5m', '']) {
      expect(() => readHelmTimeout(bad)).toThrow(/positive helm duration/);
    }
    for (const good of ['15m', '900s', '1h30m', '500ms']) expect(readHelmTimeout(good)).toBe(good);
  });

  test('a namespace or release that is not a DNS-1123 label is refused', async () => {
    const root = appRoot();
    const badNamespace = run(['--method', 'helm', '--namespace', 'Prod_1'], root);
    expect(await refusalCode(badNamespace)).toBe('X_CLI_BAD_FLAG');
    const badRelease = run(['--method', 'helm', '--release', 'x'.repeat(54)], root);
    expect(await refusalCode(badRelease)).toBe('X_CLI_BAD_FLAG');
  });

  test('an app.config.ts with no usable name is X_CONFIG_INVALID, naming --release', async () => {
    const missing = run(['--method', 'helm'], appRoot('{}'));
    expect(await refusalCode(missing)).toBe('X_CONFIG_INVALID');
    // ...and the flag it names is the way out.
    const { runner, ran } = helmRunner();
    await run(['--method', 'helm', '--release', 'app'], appRoot('{}'), runner);
    expect(ran[0]?.[3]).toBe('app');
  });

  test('stdout that is not helm’s record reads as unknown, never as deployed', () => {
    const target = { release: 'shop-web', namespace: undefined, timeout: '15m' };
    expect(readRollout(target, 'Release "shop-web" has been upgraded.')).toEqual({
      release: 'shop-web',
      namespace: null,
      revision: null,
      status: 'unknown',
    });
  });
});
