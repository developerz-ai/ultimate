#!/usr/bin/env bun
// The script catalogue. One place that lists what the repo can do to itself, so a contributor (or
// an agent) never has to read package.json to find the command.
//
//   bun run scripts/help.ts [--json]

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
    does: 'the gate — `x verify` at the repo root, all 16 steps',
  },
  {
    command: 'bun run scripts/boundaries.ts',
    does: 'enforce the tier table across packages/*/src',
  },
  {
    command: 'bun run scripts/manifest.ts',
    does: 'generate .x/manifest.json: packages, tiers, error codes',
  },
  { command: 'bun run scripts/list-workspaces.ts', does: 'the workspace table, sorted by tier' },
  {
    command: 'bun run scripts/new-package.ts <name> --tier N',
    does: 'scaffold a framework package',
  },
  { command: 'bun run scripts/release.ts --bump minor', does: 'lockstep version bump + changelog' },
  { command: 'bun run scripts/help.ts', does: 'this catalogue' },
];

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
