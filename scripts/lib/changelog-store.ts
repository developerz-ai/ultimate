// Where the changelog LIVES, read as one list: `CHANGELOG.md` is the index and holds `[Unreleased]`,
// and each release's notes are `docs/changelog/X.Y.Z.md`. Every rule reads `loadChangelog`, so no
// rule can read one place while the release writes the other.

import { CHANGELOG_PATH } from './changelog-format';
import { type Changelog, parseChangelog, UNRELEASED } from './changelog-sections';
import { toPosix } from './posix-path';

/** One file per release, named by its version. */
export const CHANGELOG_DIR = 'docs/changelog';
const VERSION_FILE = /^(\d+)\.(\d+)\.(\d+)\.md$/;

/** The file a release's notes live in, repo-relative. */
export const versionFile = (version: string): string => `${CHANGELOG_DIR}/${version}.md`;

export interface ChangelogFile {
  /** Repo-relative, `/`-spelt: `docs/changelog/31.3.0.md`. */
  readonly path: string;
  readonly text: string;
}

/** `[major, minor, patch]` of a version file's name, or undefined for any other name. */
export const fileVersion = (path: string): readonly number[] | undefined => {
  const match = VERSION_FILE.exec(path.slice(path.lastIndexOf('/') + 1));
  return match === null ? undefined : match.slice(1, 4).map((part) => Number.parseInt(part, 10));
};

/** Newest first, numerically — `10.0.0` above `9.0.0`; a name that is no version sorts last. */
export function newestFirst(a: string, b: string): number {
  const left = fileVersion(a) ?? [-1, -1, -1];
  const right = fileVersion(b) ?? [-1, -1, -1];
  for (let index = 0; index < 3; index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

/**
 * Pure: the index's `[Unreleased]`, then every version file's sections, newest first — the shape
 * one CHANGELOG.md used to parse to, each section naming the file and line it is read from.
 */
export function assembleChangelog(index: string, files: readonly ChangelogFile[]): Changelog {
  const unreleased = parseChangelog(index, CHANGELOG_PATH).filter(
    (section) => section.version === UNRELEASED,
  );
  const released = [...files]
    .sort((a, b) => newestFirst(a.path, b.path))
    .flatMap((file) => parseChangelog(file.text, file.path));
  return [...unreleased, ...released];
}

/** The index's text (empty when absent) and every `docs/changelog/*.md`, as read from disk. */
export async function readChangelogFiles(
  root: string,
): Promise<{ readonly index: string; readonly files: readonly ChangelogFile[] }> {
  const index = await Bun.file(`${root}/${CHANGELOG_PATH}`)
    .text()
    .catch(() => '');
  const files: ChangelogFile[] = [];
  const scanned = (() => {
    try {
      return [...new Bun.Glob('*.md').scanSync({ cwd: `${root}/${CHANGELOG_DIR}` })];
    } catch {
      // No directory is no release yet: the rules that need one say so (`indexFindings`).
      return [];
    }
  })();
  for (const name of scanned) {
    const path = `${CHANGELOG_DIR}/${toPosix(name)}`;
    files.push({ path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return { index, files: files.sort((a, b) => newestFirst(a.path, b.path)) };
}

/** Every changelog section in the repository at `root`, newest first. */
export async function loadChangelog(root: string): Promise<Changelog> {
  const { index, files } = await readChangelogFiles(root);
  return assembleChangelog(index, files);
}
