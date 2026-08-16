#!/usr/bin/env bun
// The workspace table: name, version, tier, publish status. Sorted by tier, which is also the
// order `release.ts` publishes in.
//
//   bun run scripts/list-workspaces.ts [--json] [--tier 5]

import { flagString, parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { allowedTiersFor } from './lib/tiers';
import { listWorkspaces } from './lib/workspaces';

const args = parseScriptArgs(Bun.argv.slice(2));
const root = repoRoot();
const tierFilter = flagString(args, 'tier');
const workspaces = (await listWorkspaces(root)).filter(
  (workspace) => tierFilter === undefined || String(workspace.tier) === tierFilter,
);

const rows = workspaces.map((workspace) => ({
  name: workspace.name,
  version: workspace.version,
  tier: workspace.tier,
  mayImport: allowedTiersFor(workspace.tier),
  publish: workspace.private ? 'private' : 'public',
}));

report(
  {
    ok: true,
    script: 'list-workspaces',
    summary: `${rows.length} workspaces`,
    lines: [
      `  ${'name'.padEnd(26)} ${'version'.padEnd(9)} tier  may import  publish`,
      ...rows.map(
        (row) =>
          `  ${row.name.padEnd(26)} ${row.version.padEnd(9)} ${String(row.tier).padEnd(5)} ${row.mayImport.padEnd(11)} ${row.publish}`,
      ),
    ],
    data: rows,
  },
  args.json,
);
