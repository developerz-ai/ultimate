// The one reader of an app's `app.config.ts`: imported here and nowhere else in the tree
// (`bun run boundaries`, `X_CONFIG_IMPORT_OUTSIDE_LOADER`), its `config` export handed back through
// core's own `defineConfig` — so every boot fact the CLI reads is the validated, default-merged
// `AppConfig`, never a structural walk with a fallback of its own.

// why: Bun exposes no path-join primitive, and the config path is app-root-relative.
import { join } from 'node:path';
import type { AppConfig, AppConfigInput } from '@ultimat3/core';
import { APP_CONFIG_FILE, ConfigInvalidError, defineConfig, describeValue } from '@ultimat3/core';

/** The export every app declares. Named, never default — the CLI and the runtime both import it. */
export const APP_CONFIG_EXPORT = 'config';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One named export of `root`'s `app.config.ts`, or `undefined` when the root has no such file or
 * the module does not export `name`. A module that will not import throws as it did — the callers
 * that report rather than crash (`x doctor`'s env check) turn that into a finding.
 */
export async function appConfigExport(root: string, name: string): Promise<unknown> {
  const path = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(path).exists())) return undefined;
  const module = (await import(path)) as Record<string, unknown>;
  return Object.hasOwn(module, name) ? module[name] : undefined;
}

/**
 * `root`'s `AppConfig`, or `undefined` when the root has no `app.config.ts` — not an app, and each
 * caller's "nothing declared" answer is its own. A file that IS there is held to `defineConfig`'s
 * one validator: a hand-built `config` object reaches the boot validated and defaulted exactly as
 * one built by `defineConfig` does, which re-merges to itself. One resolved through a 24.x core is
 * refused (its defaults wrote keys 25.0.0 removed): install every `@ultimat3/*` at one version. A file with no `config` object is refused rather than read as "every default".
 */
export async function loadAppConfig(root: string): Promise<AppConfig | undefined> {
  const path = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(path).exists())) return undefined;
  const exported = await appConfigExport(root, APP_CONFIG_EXPORT);
  if (!isRecord(exported)) {
    throw new ConfigInvalidError({
      cause: `${path} exports no ${APP_CONFIG_EXPORT} object (${describeValue(exported)})`,
      fix: "export const config = defineConfig({ name: 'my-app' });",
      meta: { key: APP_CONFIG_EXPORT },
    });
  }
  // A cast over a record whose structure `defineConfig` screens first (`shapeIssues`, per layer):
  // the validator IS the parse, and a second hand-written schema here would be a second answer.
  return defineConfig(exported as unknown as AppConfigInput);
}
