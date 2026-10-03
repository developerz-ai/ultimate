// The half of `scripts/config-readers.ts` that reads the TRACKED APPS. A `CONFIG_READER_PINS` row
// whose sentence says app code reads the key is a claim about `examples/dummy` and
// `dummy/social-media-clone`, not about `packages/*/src` — so it is checked there, or it is a
// waiver wearing a reader's name.

import { stripComments } from '../../packages/core/src/source-mask';
import { GATED_APPS } from './gated-apps';

export interface AppSource {
  readonly path: string;
  readonly text: string;
}

/** The sentence names app code as the reader. Read off the pin's own words — the claim IS prose. */
export const claimsAppReader = (reason: string): boolean =>
  /\bapp(?:lication)? code\b/i.test(reason);

export interface AppClaimGap {
  readonly kind: 'app-unread';
  readonly leaf: string;
  readonly reason: string;
}

/** Every pin claiming an app reader that no file of either tracked app reads. */
export function appClaimGaps(
  pins: Readonly<Record<string, string>>,
  appFiles: readonly AppSource[],
  pattern: (leaf: string) => RegExp,
): readonly AppClaimGap[] {
  return Object.entries(pins)
    .filter(([, reason]) => claimsAppReader(reason))
    .filter(([leaf]) => !appFiles.some((file) => pattern(leaf).test(file.text)))
    .map(([leaf, reason]) => ({ kind: 'app-unread' as const, leaf, reason }));
}

const NOT_AUTHORED = /(?:^|\/)(?:node_modules|dist|\.x)\//;

/**
 * Both apps' authored source, comments blanked. `app.config.ts` is left out: it is where the key is
 * WRITTEN, and a write is not a read. Tests are left out for the reason `packages/*` tests are: a
 * test reading a key is not the key being wired.
 */
export async function configAppSources(root: string): Promise<readonly AppSource[]> {
  const files: AppSource[] = [];
  for (const app of GATED_APPS) {
    for await (const rel of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: `${root}/${app.dir}` })) {
      if (NOT_AUTHORED.test(rel) || /\.test\.tsx?$/.test(rel) || rel.endsWith('app.config.ts')) {
        continue;
      }
      const text = await Bun.file(`${root}/${app.dir}/${rel}`).text();
      files.push({ path: `${app.dir}/${rel}`, text: stripComments(text) });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
