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

interface Manifest {
  readonly name?: unknown;
  readonly overrides?: Record<string, string>;
  readonly [key: string]: unknown;
}

/** One `file:` override per published `@ultimat3/*` package found under `repoRoot/packages`. */
export async function computeOverrides(repoRoot: string): Promise<Record<string, string>> {
  const overrides: Record<string, string> = {};
  const packagesDir = join(repoRoot, 'packages');
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

if (import.meta.main) {
  const target = process.argv[2];
  if (target === undefined) {
    console.error('usage: bun run scripts/scaffold-smoke-overrides.ts <target-dir>');
    process.exit(1);
  }
  const overrides = await computeOverrides(process.cwd());
  await applyOverrides(target, overrides);
  console.log(`wrote ${Object.keys(overrides).length} @ultimat3/* file: overrides to ${target}`);
}
