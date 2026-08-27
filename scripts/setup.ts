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

// A floor on CONTRIBUTORS to this repo. It tracks the series CI runs
// (`.github/actions/setup/action.yml`, `1.4.x`), because that is the only thing this check can
// usefully say: a contributor whose Bun differs from CI's is not running the gate CI runs, and on
// 2026-08-20 that gap merged a red PR behind a green local `bun run verify`. Matching the pin is
// the whole point; a floor a series away from it blesses a machine that agrees with nothing here.
//
// The paragraph that stood here called this a DIFFERENT question from `engines.bun` and argued that
// one should stay `>=1.3.0` — two `REQUIRED_BUN` constants, deliberately holding different numbers.
// That split is gone, `As of 2026-08-27`, and it is the same number in all three places now
// (`packages/cli/src/app-root.ts` is the third). It had already cost a real defect: the consumer
// floor sat at `1.3.0` while `x test` emitted `bun test --isolate`, a flag Bun added in 1.3.13. A
// floor nobody can compare against another floor drifts in whichever direction the last edit
// pushed it, which is axiom 3, and `scripts/bun-pin.test.ts` is what makes one number safe.
//
// Whether `1.4.0` is too HIGH — `--isolate` is a 1.3.13 feature and no package here calls a
// 1.4-only API — was tried on 2026-08-27 and refused on a measured Bun 1.3.14 shutdown hang. The
// evidence lives in `.github/actions/setup/action.yml`; do not re-derive it, and do not lower this
// constant without reading it.
const REQUIRED_BUN = [1, 4, 0] as const;

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
    // Rendered from the constant, never restated: a hardcoded number here drifts silently the next
    // time the floor moves, and this string is the only thing the contributor reads.
    cause: `Bun ${Bun.version} is older than the required ${REQUIRED_BUN.join('.')}`,
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
      // `bun.lock` is NOT deleted: it is committed, and 29 packages release in lockstep off it —
      // regenerating it here resolves fresh versions nobody reviewed, on a box whose only problem
      // was a half-written node_modules. `--frozen-lockfile` fails loudly instead of rewriting it.
      fix: 'rm -rf node_modules && bun install --frozen-lockfile',
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
