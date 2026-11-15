// Single responsibility: a framework checkout as a scratch app's `@ultimat3/*` source — which
// directory is one (its `packages/core` is `@ultimat3/core`), the one a cwd sits inside, and the
// `file:` override per package that points every install of the graph at that checkout.

// why: a cwd walk-up asks synchronously, and Bun has no directory listing.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join, resolve } from 'node:path';
import { isJsonObject } from '@ultimat3/core';

/** A checkout is the directory whose `packages/core/package.json` names `@ultimat3/core`. */
export function isFrameworkCheckout(dir: string): boolean {
  const manifest = join(dir, 'packages', 'core', 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    return isJsonObject(parsed) && parsed['name'] === '@ultimat3/core';
  } catch {
    return false;
  }
}

/** The checkout `cwd` is inside, walking up; `undefined` outside every one. */
export function frameworkCheckoutFrom(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (isFrameworkCheckout(dir)) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * One `file:` override per `@ultimat3/*` package under `<checkout>/packages`, names sorted.
 * `overrides`, never `dependencies`: most of the graph is transitive, and only an override
 * rewrites a range wherever it appears.
 */
export async function frameworkOverrides(checkout: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const packages = join(checkout, 'packages');
  if (!existsSync(packages)) return out;
  for (const dir of readdirSync(packages).sort()) {
    const manifest = Bun.file(join(packages, dir, 'package.json'));
    if (!(await manifest.exists())) continue;
    const parsed: unknown = await manifest.json().catch(() => undefined);
    const name = isJsonObject(parsed) ? parsed['name'] : undefined;
    if (typeof name === 'string' && name.startsWith('@ultimat3/')) {
      out[name] = `file:${join(packages, dir)}`;
    }
  }
  return out;
}
