// The scaffold smoke job (`.github/workflows/ci.yml`, job `scaffold-smoke`) proves `x new` →
// `bun install` → `x verify` works end to end, without waiting on an actual npm publish: it
// rewrites the freshly scaffolded app's `@ultimat3/*` ranges to `file:` overrides pointing at
// this repo's own `packages/*`, so `bun install` links the same source a real publish would ship
// instead of hitting the registry. `overrides` (not `dependencies`) because most of what a
// generated app needs is transitive — `@ultimat3/mcp` depends on `@ultimat3/schema`, which the
// app never lists directly — and only `overrides` rewrites a range wherever it appears in the
// graph, not just at the top level.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';

interface Manifest {
  readonly name?: unknown;
  readonly overrides?: Record<string, string>;
  readonly [key: string]: unknown;
}

/** One `file:` override per published `@ultimat3/*` package found under `repoRoot/packages`. */
export async function computeOverrides(repoRoot: string): Promise<Record<string, string>> {
  const overrides: Record<string, string> = {};
  const packagesDir = join(repoRoot, 'packages');
  // No `packages/` at all is the same answer as an empty one — the caller turns "found nothing"
  // into `X_SCAFFOLD_OVERRIDES_EMPTY`, which is an instruction; a raw ENOENT out of `readdirSync`
  // is not.
  if (!existsSync(packagesDir)) return overrides;
  for (const dir of readdirSync(packagesDir).sort()) {
    const manifestPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = (await Bun.file(manifestPath).json()) as Manifest;
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@ultimat3/')) {
      overrides[manifest.name] = `file:${join(packagesDir, dir)}`;
    }
  }
  return overrides;
}

/** Merges `overrides` into `targetDir/package.json`, in place. */
export async function applyOverrides(
  targetDir: string,
  overrides: Record<string, string>,
): Promise<void> {
  const pkgPath = join(targetDir, 'package.json');
  const pkg = (await Bun.file(pkgPath).json()) as Manifest;
  const merged = { ...pkg, overrides: { ...pkg.overrides, ...overrides } };
  await Bun.write(pkgPath, `${JSON.stringify(merged, null, 2)}\n`);
}

const SCRIPT = 'scaffold-smoke-overrides';

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const target = args.positionals[0];
  if (target === undefined) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: 'a target directory is required',
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: 'no target directory given, so there is no package.json to rewrite',
            fix: 'bun run scripts/scaffold-smoke-overrides.ts ./smoke-app --json',
          },
        ],
      },
      args.json,
    );
  }
  const overrides = await computeOverrides(process.cwd());
  // An empty map is the dangerous case, not a no-op: `bun install` would then resolve every
  // `@ultimat3/*` range from the NPM REGISTRY, so the smoke job would prove that the last PUBLISHED
  // release scaffolds and verifies — a claim about a different tree entirely — and report success.
  if (Object.keys(overrides).length === 0) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary:
          'no @ultimat3/* workspace packages found, so the smoke job would test the registry',
        findings: [
          {
            code: 'X_SCAFFOLD_OVERRIDES_EMPTY',
            cause: `no packages/*/package.json under ${process.cwd()} declares an @ultimat3/* name`,
            fix: 'bun run scripts/scaffold-smoke-overrides.ts ./smoke-app --json   # run it from the repo root',
          },
        ],
      },
      args.json,
    );
  }
  await applyOverrides(target, overrides);
  report(
    {
      ok: true,
      script: SCRIPT,
      summary: `${Object.keys(overrides).length} @ultimat3/* file: overrides written to ${target}`,
      data: { target, overrides },
    },
    args.json,
  );
}
