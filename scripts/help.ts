#!/usr/bin/env bun
// The script catalogue. One place that lists what the repo can do to itself, so a contributor (or
// an agent) never has to read package.json to find the command.
//
//   bun run scripts/help.ts [--json]

import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';

interface Entry {
  readonly command: string;
  readonly does: string;
}

export const SCRIPTS: readonly Entry[] = [
  { command: 'bin/setup', does: 'fresh clone to running: bun install, env, git hooks' },
  { command: 'bin/dev', does: 'run the CLI against the repo: bin/dev <x subcommand>' },
  { command: 'bin/check', does: 'the gate — same steps as CI' },
  {
    command: 'bun run scripts/verify.ts',
    // Projected, never restated: the count said 16 while the step list and CLAUDE.md said 17.
    does: `the gate — \`x verify\` at the repo root, all ${VERIFY_STEP_NAMES.length} steps`,
  },
  {
    command: 'bun run scripts/reference-app-gate.ts',
    does: "both tracked apps' own gates, on their expectedRed ratchet",
  },
  {
    command: 'bun run scripts/reference-app-gate.ts --unpin <app>:<step>',
    does: 'shrink that ratchet — the edit X_REFERENCE_APP_PIN_STALE names, performed',
  },
  {
    command: 'bun run scripts/boundaries.ts',
    does: 'enforce the tier table across packages/*/src',
  },
  {
    command: 'bun run scripts/manifest.ts',
    does: 'regenerate the committed framework.manifest.json: packages, tiers, error codes',
  },
  { command: 'bun run scripts/list-workspaces.ts', does: 'the workspace table, sorted by tier' },
  {
    command: 'bun run scripts/new-package.ts <name> --tier N',
    does: 'scaffold a framework package',
  },
  { command: 'bun run scripts/release.ts --bump minor', does: 'lockstep version bump + changelog' },
  {
    command: 'bun run scripts/release.ts --check 1.3.0',
    does: 'assert every package is stamped at the version about to be published',
  },
  {
    command: 'bun run scripts/roadmap.ts',
    does: "every roadmap milestone's status marker against what is on disk",
  },
  {
    command: 'bun run scripts/trust-publishers.ts',
    does: 'the npm trusted-publisher check behind OIDC releases',
  },
  { command: 'bun run scripts/help.ts', does: 'this catalogue' },
];

// Behind `import.meta.main`, like every other script here: `report()` ends in `process.exit`, so
// a module that runs on import takes down whatever imported it — its own test included.
if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const width = Math.max(...SCRIPTS.map((entry) => entry.command.length));

  report(
    {
      ok: true,
      script: 'help',
      summary: 'every script takes --json',
      lines: SCRIPTS.map((entry) => `  ${entry.command.padEnd(width)}  ${entry.does}`),
      data: SCRIPTS,
    },
    args.json,
  );
}
