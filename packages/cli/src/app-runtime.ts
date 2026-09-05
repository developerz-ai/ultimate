// The app's `RuntimeOverrides`, found rather than handed over. `runRole({ runtime })` has taken
// them since the seam existed, and the scaffolded `apps/web/server.ts` passes none — so an app's
// own middleware reached no process the framework boots, and `x dev` had no parameter to reach at
// all (measured 2026-09-05: `x dev` passed only the read-replica override). The contract is one
// file: `apps/<app>/runtime.ts` exports `runtime`, a `RuntimeOverrides`; `x dev` reads it, and
// `runRole` reads it when its caller passed nothing, so the two boots compose the same chain.

// why: a directory's existence — `Bun.file().exists()` answers for files, and `apps/` is a directory.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive; each candidate is joined to the app root.
import { join } from 'node:path';
import type { RuntimeOverrides } from './runtime-overrides';

/** The one file an app writes, per app directory. */
export const APP_RUNTIME_GLOB = 'apps/*/runtime.ts';
/** The export that file makes — a `RuntimeOverrides`. */
export const APP_RUNTIME_EXPORT = 'runtime';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The first `apps/<app>/runtime.ts` exporting `runtime`, or `undefined` when no app declares one.
 * Sorted, so two apps answer in one order; the object is handed on as declared, because every key
 * of `RuntimeOverrides` already means "replace the resolved default" wherever a boot reads it.
 */
export async function loadAppRuntime(root: string): Promise<RuntimeOverrides | undefined> {
  // A root with no `apps/` — a bare test fixture, a directory that does not exist — is no app
  // declaring an override, never a boot failure: the scan's ENOENT is answered as "none".
  if (!existsSync(join(root, 'apps'))) return undefined;
  const files: string[] = [];
  for await (const file of new Bun.Glob(APP_RUNTIME_GLOB).scan({ cwd: root })) files.push(file);
  for (const file of files.sort()) {
    const module = (await import(join(root, file))) as Record<string, unknown>;
    const exported = module[APP_RUNTIME_EXPORT];
    if (isRecord(exported)) return exported as RuntimeOverrides;
  }
  return undefined;
}
