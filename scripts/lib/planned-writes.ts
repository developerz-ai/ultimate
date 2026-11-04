// A generator's edits, written all-or-nothing against the text it planned from: every file is read
// once into a snapshot, and at write time a file that moved since is a refusal, never a lost update.
// Each file lands by temp + rename, so a crash leaves the old file or the new one, never half of one.

// why: Bun has no synchronous rename, unlink or read-to-string; the check and the renames have to
// run with no `await` between them, or a second run in this process could slip in after the check.
import { readFileSync, renameSync, unlinkSync } from 'node:fs';

/** The text each file had when the plan read it; `undefined` for a file that did not exist. */
export type Snapshot = Map<string, string | undefined>;

export interface FileEdit {
  readonly path: string;
  readonly text: string;
}

/** A reader that records the FIRST text it saw per path — what the plan was computed from. */
export const snapshotReader =
  (root: string, snapshot: Snapshot) =>
  async (path: string): Promise<string | undefined> => {
    const file = Bun.file(`${root}/${path}`);
    const text = (await file.exists()) ? await file.text() : undefined;
    if (!snapshot.has(path)) snapshot.set(path, text);
    return snapshot.get(path);
  };

const currentText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Write every edit, or none. Temps first (async); then, synchronously, the check that each file is
 * still the text the plan read, and the renames. `changed` lists the moved files for the refusal.
 */
export async function writePlanned(
  root: string,
  edits: readonly FileEdit[],
  snapshot: Snapshot,
  refuse: (changed: readonly string[]) => Error,
): Promise<void> {
  const tag = `${process.pid}-${crypto.randomUUID()}`;
  const temps = edits.map((edit) => ({ ...edit, temp: `${root}/${edit.path}.${tag}.tmp` }));
  for (const edit of temps) await Bun.write(edit.temp, edit.text);
  const changed = temps
    .filter((edit) => currentText(`${root}/${edit.path}`) !== snapshot.get(edit.path))
    .map((edit) => edit.path);
  if (changed.length > 0) {
    for (const edit of temps) unlinkSync(edit.temp);
    throw refuse(changed);
  }
  for (const edit of temps) renameSync(edit.temp, `${root}/${edit.path}`);
}
