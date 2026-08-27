// Single responsibility: the one source image every generated icon derives from, where the matrix
// is served, and the renderer that turns one into the other. Its own module so the two things that
// need it — `dev-assets.ts`, which SERVES the matrix, and `pwa-artifacts.ts`, which NAMES it in the
// web manifest — can share it without importing each other.

// why: Bun exposes no path-join primitive, and `ICON_SOURCE` is app-root-relative, so resolving it
// against the root is string work no `Bun.file` overload does.
import { join } from 'node:path';
import type { IconPlan } from '@ultimat3/pwa';
import { BuiltinImagePipeline, PwaIconMissingError, planIcons } from '@ultimat3/pwa';

/**
 * The one source image every generated icon derives from. `x new` scaffolds it, `x doctor` checks
 * it and this file reads it — one constant, because a second spelling is an app that passes the
 * diagnostic and still serves no icons. PNG, not SVG: core's pipeline decodes PNG and JPEG only.
 */
export const ICON_SOURCE = 'apps/web/site/icon.png';

/** Where `planIcons` writes, and therefore the paths the generated web manifest names. */
export const ICON_BASE_PATH = '/icons';

/**
 * The matrix's whole plan, off one constant pair. One call, so the icons `/icons/*` serves and the
 * icons `manifest.webmanifest` names can never be two different lists.
 */
export const iconPlan = (): IconPlan =>
  planIcons({ sourceIcon: ICON_SOURCE, outDir: ICON_BASE_PATH });

/**
 * Whether the app committed the one file the whole matrix derives from. Read where the answer
 * changes what is EMITTED — a manifest naming twelve icons an app has no source for is twelve 404s
 * in an install prompt, which is the promise-nothing-keeps shape this module's callers exist to
 * close. `x doctor` owns the diagnostic and reports the same condition with `X_PWA_ICON_MISSING`.
 */
export const hasSourceIcon = (root: string): Promise<boolean> =>
  Bun.file(join(root, ICON_SOURCE)).exists();

/**
 * Rendered once per process, not per request: the fourteen matrix entries are pure functions of
 * one source file, and re-encoding a 512px PNG on every hit would be work no caller can observe.
 */
export function iconRenderer(root: string): (plan: IconPlan, path: string) => Promise<Uint8Array> {
  const pipeline = new BuiltinImagePipeline();
  const rendered = new Map<string, Promise<Uint8Array>>();
  const sourceBytes = async (): Promise<Uint8Array> => {
    const file = Bun.file(join(root, ICON_SOURCE));
    if (!(await file.exists())) {
      throw new PwaIconMissingError(
        `${ICON_SOURCE} does not exist, so every icon the web manifest declares is unbacked and ` +
          'the app is not installable',
        // The same edit `x doctor` reports for the same condition, in `@ultimat3/pwa`'s own words.
        // `x new` was here and takes an app name, so it could never run inside the broken app.
        `add a 1024x1024 square PNG at ${ICON_SOURCE}`,
      );
    }
    return file.bytes();
  };
  return async (plan, path) => {
    const entry = plan.entries.find((candidate) => candidate.outputPath === path);
    if (entry === undefined) {
      throw new PwaIconMissingError(
        `${path} is not in the icon matrix, so no transform describes it`,
        `request one of ${plan.entries.map((one) => one.outputPath).join(', ')}`,
      );
    }
    const existing = rendered.get(path);
    if (existing !== undefined) return existing;
    const bytes = sourceBytes().then((source) => pipeline.resize(source, entry.transform));
    rendered.set(path, bytes);
    // A failed render must not be remembered — the next request comes after the source was added.
    bytes.catch(() => rendered.delete(path));
    return bytes;
  };
}
