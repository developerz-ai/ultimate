// TEST-ONLY. One shipped guard, run BUILT IN — as every app runs it — over a throwaway root holding
// a case's files and a `guards/shipped.json` turning every other one off, through the seam the
// `boundaries` step calls. Shared by the guard suites: a whole `x new` scaffold per case (166
// files) is what made the older ones slow.

import { expect } from 'bun:test';
// why: Bun ships no temp-directory, symlink or mkdir API; `node:fs/promises` is the only one.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { type GuardReport, guardReport } from '../guards';
import { SHIPPED_GUARD_CONFIG } from '../guards-built-in';
import type { Finding } from '../output';
import { SHIPPED_GUARD_NAMES } from './scaffold-guards';

/** This repo's `@ultimat3/ui`, for a tree whose stylesheets `@use '@ultimat3/ui/tokens'`. */
const UI_PACKAGE = Bun.fileURLToPath(new URL('../../../ui', import.meta.url));

/** Make `@ultimat3/ui` resolve from `root`, as `bun install` would have. */
export async function linkUi(root: string): Promise<void> {
  await mkdir(join(root, 'node_modules/@ultimat3'), { recursive: true });
  await symlink(UI_PACKAGE, join(root, 'node_modules/@ultimat3/ui'));
}

/**
 * The gate's report of ONE shipped guard over `files`: what fails it, and what a report-only guard
 * lists. `ui: true` links the token package first, which a fixture needs only when a sheet in it
 * uses the tokens and the guard compiles it.
 */
export async function shippedGuardReport(
  name: string,
  files: Readonly<Record<string, string>>,
  options: { readonly ui?: boolean } = {},
): Promise<GuardReport> {
  const root = await mkdtemp(join(tmpdir(), `x-guard-${name}-`));
  try {
    if (!SHIPPED_GUARD_NAMES.includes(name)) expect.unreachable(`${name} is not a shipped guard`);
    const others = SHIPPED_GUARD_NAMES.filter((other) => other !== name);
    const severity = Object.fromEntries(others.map((other) => [other, 'off']));
    await Bun.write(join(root, SHIPPED_GUARD_CONFIG), JSON.stringify({ severity }));
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    if (options.ui === true) await linkUi(root);
    return await guardReport(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Everything ONE shipped guard reports over `files`, failing or report-only alike. */
export const shippedGuardFindings = async (
  name: string,
  files: Readonly<Record<string, string>>,
  options: { readonly ui?: boolean } = {},
): Promise<readonly Finding[]> => {
  const report = await shippedGuardReport(name, files, options);
  return [...report.findings, ...report.warnings];
};
