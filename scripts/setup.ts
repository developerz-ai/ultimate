#!/usr/bin/env bun
// Fresh clone to running. Idempotent, so it is safe to re-run after every pull.
//
//   bun run scripts/setup.ts [--json] [--skip-install]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';

const REQUIRED_BUN = [1, 3, 0] as const;

const bunTooOld = (version: string): boolean => {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const found = parts[index] ?? 0;
    const required = REQUIRED_BUN[index] ?? 0;
    if (found !== required) return found < required;
  }
  return false;
};

const args = parseScriptArgs(Bun.argv.slice(2));
const root = repoRoot();
const findings: Finding[] = [];
const lines: string[] = [];

if (bunTooOld(Bun.version)) {
  findings.push({
    code: 'X_BUN_VERSION',
    cause: `Bun ${Bun.version} is older than the required 1.3.0`,
    fix: 'bun upgrade',
  });
} else {
  lines.push(`  bun ${Bun.version}`);
}

if (findings.length === 0 && !flagBool(args, 'skip-install')) {
  const install = await run(['bun', 'install'], { cwd: root });
  if (install.ok) {
    lines.push(`  dependencies installed in ${install.durationMs}ms`);
  } else {
    findings.push({
      code: 'X_SETUP_INSTALL_FAILED',
      cause: `bun install exited ${install.code}`,
      fix: 'rm -rf node_modules bun.lock && bun install',
    });
  }
}

const localEnv = join(root, '.env.development.local');
if (!existsSync(localEnv)) {
  await Bun.write(
    localEnv,
    '# Per-box overrides and secrets. Gitignored; wins over .env.development.\n',
  );
  lines.push('  wrote .env.development.local');
}

if (findings.length === 0) {
  const hooks = await run(['bunx', 'lefthook', 'install'], { cwd: root });
  lines.push(hooks.ok ? '  git hooks installed' : '  git hooks skipped (lefthook not available)');
}

report(
  {
    ok: findings.length === 0,
    script: 'setup',
    summary:
      findings.length === 0 ? 'setup complete — next: bin/check' : 'setup could not complete',
    findings,
    lines,
    data: { bun: Bun.version, root },
  },
  args.json,
);
