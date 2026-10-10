// The files a generator's follow-up edits read and write, behind one seam — so `x g --dry-run` can
// run the SAME edits against the plan and answer every path a real run would touch. The dry run
// listed the files a generator creates and none it edits: the role map, the typed handle, the API
// index and two manifests changed under a plan that never named them.

import { containedPath } from './generate-write';

/** App-root-relative reads and writes. A read of a file that is not there answers `undefined`. */
export interface GenerateDisk {
  read(path: string): Promise<string | undefined>;
  write(path: string, contents: string): Promise<void>;
}

/** The app's own disk. */
export const appDisk = (root: string): GenerateDisk => ({
  async read(path) {
    const file = Bun.file(containedPath(root, path));
    return (await file.exists()) ? await file.text() : undefined;
  },
  async write(path, contents) {
    await Bun.write(containedPath(root, path), contents);
  },
});

/**
 * The disk as it WOULD stand after a run: `planned` is what the run creates, read before the real
 * file, and a write lands in memory only. Nothing under `root` changes.
 */
export const plannedDisk = (root: string, planned: ReadonlyMap<string, string>): GenerateDisk => {
  const held = new Map(planned);
  const real = appDisk(root);
  return {
    read: async (path) => held.get(path) ?? (await real.read(path)),
    async write(path, contents) {
      held.set(path, contents);
    },
  };
};
