#!/usr/bin/env bun
// Stop: before the main session ends a turn, check the two derived files a change can leave stale
// — `framework.manifest.json` and the tracked apps' schema dumps — and block once with the command
// that regenerates them. Only checks what the uncommitted change can reach; a second stop in a row
// (`stop_hook_active`) always passes, so a stale file the turn cannot fix is never a hang.

export type DriftCheck = 'manifest' | 'schema-dumps';

export interface Stale {
  readonly check: DriftCheck | string;
  readonly fix: string;
}

/** The derived files a set of changed paths (repository-relative) can stale. */
export function driftChecksFor(paths: readonly string[]): readonly DriftCheck[] {
  const posix = paths.map((path) => path.split('\\').join('/'));
  const checks: DriftCheck[] = [];
  if (posix.some((path) => /^(packages|scripts)\/.+\.(tsx?|json)$/.test(path)))
    checks.push('manifest');
  if (posix.some((path) => /(^|\/)entity\.tsx?$/.test(path) || /(^|\/)packages\/db\//.test(path)))
    checks.push('schema-dumps');
  return checks;
}

interface StopRecord {
  readonly stop_hook_active?: unknown;
  readonly agent_type?: unknown;
}

/** Block the stop only for the main session, only once, only when something is stale. */
export function stopVerdict(
  record: StopRecord,
  stale: readonly Stale[],
): { readonly decision: 'block'; readonly reason: string } | undefined {
  if (record.stop_hook_active === true || typeof record.agent_type === 'string') return undefined;
  if (stale.length === 0) return undefined;
  const lines = stale.map((item) => `- ${item.check} is stale — run: ${item.fix}`);
  return {
    decision: 'block',
    reason: `Derived files no longer match the tree (.claude/hooks/stop-drift.ts):\n${lines.join('\n')}\nIf agents are still writing, regenerate once they are done and say so; the gate's manifest step refuses the stale copy either way.`,
  };
}

async function staleIn(root: string, checks: readonly DriftCheck[]): Promise<readonly Stale[]> {
  const stale: Stale[] = [];
  if (checks.includes('manifest')) {
    const { frameworkManifestDrift } = await import('../../scripts/manifest');
    const drift = await frameworkManifestDrift(root);
    if (drift.length > 0)
      stale.push({
        check: `framework.manifest.json (${drift.join(', ')})`,
        fix: 'bun run manifest',
      });
  }
  if (checks.includes('schema-dumps')) {
    const proc = Bun.spawnSync(['bun', 'run', 'schema-dumps', '--check'], {
      cwd: root,
      timeout: 30_000,
    });
    if (proc.exitCode !== 0)
      stale.push({ check: 'packages/db/schema/ dumps', fix: 'bun run schema-dumps' });
  }
  return stale;
}

async function main(): Promise<void> {
  const input: unknown = JSON.parse((await Bun.stdin.text()) || '{}');
  const record: StopRecord = typeof input === 'object' && input !== null ? input : {};
  if (stopVerdict(record, [{ check: 'probe', fix: '' }]) === undefined) return;
  const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel']);
  if (top.exitCode !== 0) return;
  const root = top.stdout.toString().trim();
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
  });
  // `XY path` or `XY old -> new`: the path the tree now holds is the last word.
  const paths = status.stdout
    .toString()
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).split(' -> ').at(-1) ?? '');
  const verdict = stopVerdict(record, await staleIn(root, driftChecksFor(paths)));
  if (verdict !== undefined) process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

if (import.meta.main) await main();
