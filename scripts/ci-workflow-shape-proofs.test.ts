// ci.yml's shape past the gate's parts: what the split may not change, a deploy proof that inherits
// a verdict only from a proof that passed, and the TLS replication suite running in CI.
// Split from ci-workflow-shape.test.ts.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { expr, type Job, jobOf, planRows, readWorkflow, text } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const read = readWorkflow;

const ci = await read('ci.yml');
const job = (name: string): Job => jobOf(ci, name);
const runsOf = (target: Job): string =>
  (target.steps ?? []).map((step) => step.run ?? '').join('\n');

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const rows = await planRows(ci);

describe('unit · ci.yml · what the split may not change', () => {
  test('container builds the demo image once and refuses it past its measured ceiling', () => {
    const run = runsOf(job('container'));
    expect(run).toContain('docker build -f dummy/social-media-clone/docker/Dockerfile.monorepo');
    expect(run).toContain('docker export "$(docker create social-demo:ci)" | wc -c');
    expect(Number(/^\s*ceiling=(\d+)$/m.exec(run)?.[1])).toBeGreaterThan(202_533_376);
    expect(run).toContain('[ "$bytes" -gt "$ceiling" ]');
    expect(run).toContain(
      'fix: narrow dummy/social-media-clone/docker/Dockerfile.monorepo.dockerignore',
    );
    expect(run.split('Dockerfile.monorepo -t').length).toBe(2);
  });

  test('free runners only: ubuntu-latest, and windows-latest / macos-latest for their own jobs', () => {
    // `windows-latest` and `macos-latest` are free because the repository is public; each is
    // admitted for the one job whose question is the platform, never as a second Linux job.
    const platforms: Readonly<Record<string, string>> = {
      windows: 'windows-latest',
      macos: 'macos-latest',
    };
    const allowed = (name: string): string => platforms[name] ?? 'ubuntu-latest';
    const runners = Object.entries(ci.jobs ?? {}).map(([name, target]) => [
      name,
      target['runs-on'],
    ]);
    expect(runners.filter(([name, runner]) => runner !== allowed(name ?? ''))).toEqual([]);
    expect(job('windows')['runs-on']).toBe('windows-latest');
    expect(job('macos')['runs-on']).toBe('macos-latest');
  });

  // The two questions a stranger's first hour asks of CI (plan 101, 42-adopt-first-hour): does a
  // fresh scaffold's Compose deploy boot, and does the scaffold gate green on a Mac.
  test('a fresh scaffold is deployed with Compose, and gated on macOS', () => {
    expect(runsOf(job('compose-deploy'))).toContain('bash docker/deploy-proof/compose.sh');
    expect(runsOf(job('macos'))).toContain('scripts/scaffold-gate.ts');
  });

  test('a missing browser is a refusal in CI, never a skip', () => {
    expect(ci.env?.['E2E_BROWSER_REQUIRED']).toBe('1');
    expect(ci.env?.['ULTIMATE_TEST_SEED']).toBe('20260101');
  });

  // A job or a step allowed to fail is not part of the gate: the run concludes `success` over it,
  // and that conclusion is the one `release.yml` publishes on. Both scopes, in every job — a step
  // marked `continue-on-error` hides its red exactly as a job marked so does.
  test('every job and every step is required — no continue-on-error at either scope', () => {
    const optional = Object.entries(ci.jobs ?? {}).flatMap(([name, target]) => [
      ...(target['continue-on-error'] === undefined ? [] : [name]),
      ...(target.steps ?? [])
        .filter((step) => step['continue-on-error'] !== undefined)
        .map((step) => `${name} › ${step.name ?? step.uses ?? step.run ?? '?'}`),
    ]);
    expect(optional).toEqual([]);
  });

  // `tested` is the one job they wait on: a few seconds that decide whether they run at all. The
  // jobs no prose can reach wait on `changes` too (`scripts/ci-workflow-changes.test.ts`), and so
  // does `packages`, whose page-reading suites the gate's `unit` runs anyway; the gate and the app
  // gates never do — the doc guards read exactly what `changes` skips for.
  test('no job in the gate waits on a job outside it, except the tested and changes questions', () => {
    for (const name of ['gate', 'reference-app-verify']) {
      expect(job(name).needs, `${name} must wait on tested alone`).toBe('tested');
    }
    for (const name of [
      'packages',
      'scaffold-smoke',
      'container',
      'compose-deploy',
      'windows',
      'macos',
      'fault-drills',
    ]) {
      expect(job(name).needs, `${name} must wait on tested and changes alone`).toEqual([
        'tested',
        'changes',
      ]);
    }
  });
});

describe('unit · ci.yml · deploy-proof inherits a verdict only from a proof that passed', () => {
  // K15: the path filter diffed against `github.event.before` alone, so a red proof on A was
  // hidden by a B that touched no deciding path, and release.yml published from B. The decision
  // is now one unit-tested script (`scripts/deploy-proof-due.test.ts`); this holds ci.yml to it.
  const proof = job('deploy-proof');
  const steps = proof.steps ?? [];
  const decide = steps.findIndex((step) => step.id === 'paths');

  test('the decision is scripts/deploy-proof-due.ts, reading the API with the run`s own token', () => {
    expect(decide).toBeGreaterThanOrEqual(0);
    expect(text(steps[decide]?.run).trim()).toBe('bun run scripts/deploy-proof-due.ts');
    expect(steps[decide]?.env?.['GH_TOKEN']).toBe(expr('github.token'));
    expect(proof.permissions).toEqual({ contents: 'read', actions: 'read' });
    // The script runs on Bun, so the setup is not behind the decision any more.
    const setup = steps.findIndex((step) => step.uses === './.github/actions/setup');
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(setup).toBeLessThan(decide);
    expect(steps[setup]?.if).toBeUndefined();
  });

  test('no second filter beside it, and every step after it obeys it', () => {
    expect(JSON.stringify(steps)).not.toContain('event.before');
    const after = steps.slice(decide + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const step of after) expect(step.if).toBe("steps.paths.outputs.run == 'true'");
  });
});

describe('unit · ci.yml · the TLS replication suite runs in CI', () => {
  // #519: `pg-tls.live.test.ts` skipped in every run because nothing started a TLS server or
  // exported its CA — a live step green over a suite that never ran. `live` is sharded, and the
  // shard the suite lands on is the sorted file list's: every live part must start it.
  const live = rows.filter((row) => text(row['only']).split(',').includes('live'));

  test('every live part starts postgres-tls and exports its URL and its CA', () => {
    expect(live.length).toBeGreaterThan(0);
    for (const row of live) {
      expect(text(row['services']).split(' ')).toContain('postgres-tls');
      const urls = text(row['urls']).split('|');
      expect(urls).toContain('TEST_TLS_REPLICATION_URL');
      expect(urls).toContain('TEST_TLS_ROOT_CERT');
    }
  });

  test('the suite dials 5440, the port compose publishes, and trusts the CA compose writes', async () => {
    const root = repoRoot();
    const env = new Map(
      (await Bun.file(`${root}/docker/test-services.env`).text())
        .split('\n')
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const compose = Bun.YAML.parse(
      await Bun.file(`${root}/docker/docker-compose.test.yml`).text(),
    ) as { readonly services?: Readonly<Record<string, Readonly<Record<string, unknown>>>> };
    const tls = compose.services?.['postgres-tls'] ?? {};

    expect(new URL(env.get('TEST_TLS_REPLICATION_URL') ?? 'x:').port).toBe('5440');
    expect(listOf(tls['ports'])).toEqual(['127.0.0.1:5440:5432', '127.0.0.2:5440:5432']);
    expect(listOf(tls['command']).join(' ')).toContain('wal_level=logical');
    expect(listOf(tls['command']).join(' ')).toContain('ssl=on');
    // Repo-relative, as every suite runs from the root; the directory is the one compose mounts.
    expect(env.get('TEST_TLS_ROOT_CERT')).toBe('docker/.tls/ca.crt');
    expect(listOf(tls['volumes'])).toContain('./.tls:/tls:ro');
  });
});
