// Which gate-part documents one CI run's verdict merges: per part, the newest attempt's. A "re-run
// failed jobs" keeps every earlier attempt's artifacts in the run, so `verify` downloads the red
// part it replaced beside the green rerun. Pure; `scripts/verify-parts.ts` reads the directory.

/** `<part>.attempt-<n>.json` — what each `gate` job writes, `n` being `github.run_attempt`. */
const ATTEMPT_DOC = /^(.+)\.attempt-([1-9]\d*)\.json$/;

export interface AttemptParts {
  /** The newest document of each part, in path order: what `x verify merge` is handed. */
  readonly current: readonly string[];
  /** An earlier attempt's document of a part that has a newer one. */
  readonly superseded: readonly string[];
  /** A document that names no attempt: it cannot be ordered against another, so it is not merged. */
  readonly unnamed: readonly string[];
}

const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;

export function currentAttemptParts(files: readonly string[]): AttemptParts {
  const newest = new Map<string, { readonly path: string; readonly attempt: number }>();
  const superseded: string[] = [];
  const unnamed: string[] = [];
  for (const path of files) {
    const match = ATTEMPT_DOC.exec(baseName(path));
    if (match === null) {
      unnamed.push(path);
      continue;
    }
    const part = match[1] ?? '';
    const attempt = Number(match[2]);
    const held = newest.get(part);
    if (held === undefined) newest.set(part, { path, attempt });
    else if (attempt > held.attempt) {
      superseded.push(held.path);
      newest.set(part, { path, attempt });
    } else superseded.push(path);
  }
  const sorted = (paths: readonly string[]): string[] => [...paths].sort();
  return {
    current: sorted([...newest.values()].map((doc) => doc.path)),
    superseded: sorted(superseded),
    unnamed: sorted(unnamed),
  };
}
