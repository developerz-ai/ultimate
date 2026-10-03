#!/usr/bin/env bun
// The workspace table: name, version, tier, publish status — in the order `release.yml` publishes
// in, which `publishSequence` derives: tier first, then dependencies before dependants.
//
//   bun run scripts/list-workspaces.ts [--json] [--tier 5]

import { flagString, parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ABOVE_TABLE, allowedTiersFor, TIERS } from './lib/tiers';
import type { Workspace } from './lib/workspaces';
import { listWorkspaces, publishSequence, WORKSPACE_GLOB } from './lib/workspaces';

const SCRIPT = 'list-workspaces';

/** Every tier a workspace can sit at: the table's, and the one above it `create-ultimate` holds. */
export const KNOWN_TIERS: readonly string[] = [
  ...new Set([...Object.keys(TIERS), ...Object.values(ABOVE_TABLE).map(String)]),
].sort();

const refused = (summary: string, finding: Finding): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary,
  findings: [finding],
});

/**
 * Pure, so the refusals are fixtures. `--tier 9` answered `ok: true, "0 workspaces"`: a typo read
 * exactly like a tier with nothing in it, and an empty table read like a tree with no packages.
 */
export function workspaceTable(
  workspaces: readonly Workspace[],
  tierFilter: string | undefined,
): ScriptResult {
  if (tierFilter !== undefined && !KNOWN_TIERS.includes(tierFilter)) {
    return refused(`--tier ${tierFilter} is not a tier`, {
      code: 'X_CLI_BAD_FLAG',
      cause: `--tier ${tierFilter} is not one of ${KNOWN_TIERS.join(', ')}`,
      fix: 'bun run scripts/list-workspaces.ts --tier 0 --json',
    });
  }
  const rows = publishSequence(workspaces)
    .filter((workspace) => tierFilter === undefined || String(workspace.tier) === tierFilter)
    .map((workspace) => ({
      name: workspace.name,
      version: workspace.version,
      tier: workspace.tier,
      mayImport: allowedTiersFor(workspace.tier),
      publish: workspace.private ? 'private' : 'public',
    }));
  if (rows.length === 0) {
    return refused('0 workspaces — this is not the tree it should be', {
      code: 'X_CORPUS_UNSCANNED',
      cause: `${WORKSPACE_GLOB} matched no workspace${tierFilter === undefined ? '' : ` at tier ${tierFilter}`}, so the release plan derived from this table would publish nothing`,
      fix: 'cd "$(git rev-parse --show-toplevel)" && bun run scripts/list-workspaces.ts --json',
      at: WORKSPACE_GLOB,
    });
  }
  return {
    ok: true,
    script: SCRIPT,
    summary: `${rows.length} workspaces`,
    lines: [
      `  ${'name'.padEnd(26)} ${'version'.padEnd(9)} tier  may import  publish`,
      ...rows.map(
        (row) =>
          `  ${row.name.padEnd(26)} ${row.version.padEnd(9)} ${String(row.tier).padEnd(5)} ${row.mayImport.padEnd(11)} ${row.publish}`,
      ),
    ],
    data: rows,
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(workspaceTable(await listWorkspaces(repoRoot()), flagString(args, 'tier')), args.json);
}
