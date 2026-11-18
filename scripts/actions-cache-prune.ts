#!/usr/bin/env bun
// Keep this repository's Actions cache under GitHub's 10 GB cap: delete each entry a newer one on
// the same ref and key family supersedes, where only the newest is ever restored. A dry run unless
// `--apply`; red when what stays is still over budget, so the scheduled run is itself the alarm.
//
//   bun run scripts/actions-cache-prune.ts [--apply] [--json]

import { isJsonObject } from '../packages/core/src/json-object';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import { ScriptError } from './lib/script-error';

export interface CacheEntry {
  readonly id: number;
  readonly ref: string;
  readonly key: string;
  readonly sizeInBytes: number;
  readonly createdAt: string;
}

/**
 * The key prefixes whose newest entry per ref is the only one ever restored. CodeQL's default setup
 * saves a ~1.1 GB overlay base per push to `main` and deletes none: nine of them (10.1 GB) filled
 * the cap on 2026-11-18 and evicted every install cache. A `bun-<os>-` entry is keyed on bun.lock,
 * so an older lockfile's is dead. Content-addressed keys (buildkit layers) are never listed here:
 * many of those are live at once.
 */
export const SUPERSEDED_PREFIXES = [
  'codeql-overlay-base-database-',
  'bun-Linux-',
  'bun-macOS-',
  'bun-Windows-',
] as const;

/** Under GitHub's 10 GB cap with room for one more CodeQL base before eviction starts. */
export const BUDGET_BYTES = 8_000_000_000;

/**
 * The key without its trailing commit or lockfile digest (40 or 64 hex) and CodeQL's
 * `-<run id>-<attempt>`: what entries superseding each other share. CodeQL's 16-hex config hash
 * stays in the family, so another query configuration's base is never the one deleted.
 */
const familyOf = (key: string): string | undefined =>
  SUPERSEDED_PREFIXES.some((prefix) => key.startsWith(prefix))
    ? key.replace(/-[0-9a-f]{40,}(?:-\d+-\d+)?$/, '')
    : undefined;

/** Every entry an entry with the same ref and family, created later, makes dead. */
export const supersededEntries = (entries: readonly CacheEntry[]): CacheEntry[] => {
  const newest = new Map<string, CacheEntry>();
  const dead: CacheEntry[] = [];
  const ordered = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const entry of ordered) {
    const family = familyOf(entry.key);
    if (family === undefined) continue;
    const group = `${entry.ref}\u0000${family}`;
    if (newest.has(group)) dead.push(entry);
    else newest.set(group, entry);
  }
  return dead;
};

/** One `gh api` cache object, or undefined for anything that is not one. */
export const entryOf = (value: unknown): CacheEntry | undefined => {
  if (!isJsonObject(value)) return undefined;
  const { id, ref, key, size_in_bytes: size, created_at: createdAt } = value;
  if (typeof id !== 'number' || typeof ref !== 'string' || typeof key !== 'string')
    return undefined;
  if (typeof size !== 'number' || typeof createdAt !== 'string') return undefined;
  return { id, ref, key, sizeInBytes: size, createdAt };
};

const apiFailed = (what: string, output: string): ScriptError =>
  new ScriptError({
    code: 'X_ACTIONS_CACHE_API_FAILED',
    cause: `gh could not ${what}: ${output.split('\n')[0] ?? ''}`,
    fix: 'gh auth status && gh api repos/{owner}/{repo}/actions/cache/usage   # a token with actions: write',
  });

const listEntries = async (root: string): Promise<CacheEntry[]> => {
  const listed = await run(
    [
      'gh',
      'api',
      '--paginate',
      'repos/{owner}/{repo}/actions/caches?per_page=100',
      '--jq',
      '.actions_caches[]',
    ],
    { cwd: root },
  );
  if (!listed.ok) throw apiFailed('list the Actions caches', listed.output);
  const lines = listed.output.split('\n').filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw apiFailed('read a cache entry as JSON', line);
    }
    const entry = entryOf(parsed);
    if (entry === undefined) throw apiFailed('read a cache entry', line);
    return entry;
  });
};

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`;

/** GitHub evicted the entry between the listing and the delete: the outcome wanted, not a failure. */
export const alreadyGone = (output: string): boolean => /HTTP 404/.test(output);

const overBudget = (kept: number): Finding => ({
  code: 'X_ACTIONS_CACHE_OVER_BUDGET',
  cause: `${gb(kept)} of Actions cache stays after pruning, over the ${gb(BUDGET_BYTES)} budget under GitHub's 10 GB cap: entries are evicted before CI restores them`,
  fix: 'bun run scripts/actions-cache-prune.ts --json   # then add the largest superseded family to SUPERSEDED_PREFIXES, or shrink that cache',
  at: 'scripts/actions-cache-prune.ts',
});

const prune = async (root: string, apply: boolean): Promise<ScriptResult> => {
  const entries = await listEntries(root);
  const dead = supersededEntries(entries);
  for (const entry of apply ? dead : []) {
    const deleted = await run(
      ['gh', 'api', '-X', 'DELETE', `repos/{owner}/{repo}/actions/caches/${entry.id}`],
      { cwd: root },
    );
    if (!deleted.ok && !alreadyGone(deleted.output)) {
      throw apiFailed(`delete cache ${entry.id} (${entry.key})`, deleted.output);
    }
  }
  const total = entries.reduce((sum, entry) => sum + entry.sizeInBytes, 0);
  const freed = dead.reduce((sum, entry) => sum + entry.sizeInBytes, 0);
  const kept = total - freed;
  const findings = kept > BUDGET_BYTES ? [overBudget(kept)] : [];
  return {
    ok: findings.length === 0,
    script: 'actions-cache-prune',
    summary: `${apply ? 'deleted' : 'would delete'} ${dead.length} superseded of ${entries.length} cache entries (${gb(freed)}); ${gb(kept)} stays`,
    findings,
    data: { apply, total, freed, kept, superseded: dead.map((entry) => entry.key) },
  };
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: ['apply'],
    refuse: (unknown) =>
      new ScriptError({
        code: 'X_CLI_BAD_FLAG',
        cause: `actions-cache-prune reads --apply and --json only, and was given --${unknown.join(', --')}`,
        fix: 'bun run scripts/actions-cache-prune.ts --json   # then --apply',
      }),
  });
  try {
    report(await prune(repoRoot(), flagBool(args, 'apply')), args.json);
  } catch (error) {
    if (!(error instanceof ScriptError)) throw error;
    const { code, cause, fix } = error;
    report(
      {
        ok: false,
        script: 'actions-cache-prune',
        summary: 'the Actions cache could not be pruned',
        findings: [{ code, cause, fix }],
      },
      args.json,
    );
  }
}
