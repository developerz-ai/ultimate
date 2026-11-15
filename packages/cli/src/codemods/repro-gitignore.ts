// Carries an older app's `.gitignore` to the 31.28.0 scaffold's: the line that keeps an
// `x repro --bundle` file — redacted, but meant for an issue, never the repository — out of a
// commit. Idempotent; an app that already ignores `repro/` whole is left alone; no file, no file.

import type { Codemod } from './codemod';

/** The line, as `x new`'s `.gitignore` (`templates/scaffold-repo.ts`) writes it. */
export const REPRO_BUNDLE_IGNORE = 'repro/bundle-*.json';

const GITIGNORE = '.gitignore';

/** Lines that already keep a bundle out: this one, or the whole `repro/` directory. */
const COVERING = new Set([REPRO_BUNDLE_IGNORE, `/${REPRO_BUNDLE_IGNORE}`, 'repro/', '/repro/']);

export const codemod: Codemod = {
  id: 'repro-gitignore',
  since: '31.28.0',
  summary: `.gitignore gains ${REPRO_BUNDLE_IGNORE}: an x repro --bundle file is for an issue, never a commit`,
  async run(app) {
    const source = await app.read(GITIGNORE);
    if (source === undefined) {
      return {
        changed: [],
        skipped: [
          {
            path: GITIGNORE,
            reason: `the app has no .gitignore, so none was created; add ${REPRO_BUNDLE_IGNORE} to whatever keeps files out of its commits`,
            diff: `+${REPRO_BUNDLE_IGNORE}`,
          },
        ],
      };
    }
    const lines = source.split(/\r?\n/).map((line) => line.trim());
    if (lines.some((line) => COVERING.has(line))) return { changed: [], skipped: [] };
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const base = source === '' || source.endsWith('\n') ? source : `${source}${eol}`;
    await app.write(GITIGNORE, `${base}${REPRO_BUNDLE_IGNORE}${eol}`);
    return { changed: [GITIGNORE], skipped: [] };
  },
};
