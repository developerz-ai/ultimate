// `ui.diff` — the one `ui.*` tool with no browser in it: two captured PNGs compared, the
// difference written back as a third.
//
// Two PNGs the others wrote, decoded and compared by `shot-diff.ts` (shared with
// `x shot --against`), and written back as a third PNG beside the second. This file is the gate:
// which paths may be read and written, and that both captures are one size.
//
// The path gate is what makes `dev:read` defensible for a tool that opens files: `before`, `after`
// and `out` are relative to the app root and must resolve — lexically AND through any symlink —
// inside `.x/shot/`, the directory only `x shot` and the `ui.*` tools write. A token that may read
// the route table may read the pictures of those routes; it may not read `.env` through a tool
// that says "diff".

// why: Bun has no realpath of its own, and a symlink under .x/shot/ pointing out of it is the
// one path the lexical check cannot see.
import { realpath } from 'node:fs/promises';
// why: Bun exposes no path primitives; the gate is a resolve-then-prefix check on joined paths.
import { dirname, resolve, sep } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import type { UiDiffInput, UiDiffResult } from '@ultimat3/mcp';
import { compareRasters, decodeCapture, hash8 } from './shot-diff';
import { SHOT_DIR } from './shot-server';

export interface DiffDeps {
  readonly root: string;
}

const SHOT_FIX =
  'x shot / --json   # then pass the image path it answers, relative to the app root: ui.diff reads .x/shot/ and nothing else';

/** `true` when `path` is `dir` or lies under it — a prefix check on whole segments, never on chars. */
const under = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

/**
 * The lexical half of the gate: `root/<relative>` resolved, then held under `root/.x/shot`. An
 * absolute `relative` resolves to itself, and `..` segments resolve away, so both leave through
 * the same refusal.
 */
export function shotPath(root: string, relative: string, field: string): string {
  const shotDir = resolve(root, SHOT_DIR);
  const path = resolve(root, relative);
  if (!under(path, shotDir)) {
    throw new UltimateError({
      code: 'X_UI_DIFF_PATH_OUTSIDE',
      cause: `${field} resolves to ${path}, which is not inside ${shotDir}`,
      fix: SHOT_FIX,
      meta: { field, path, shotDir },
    });
  }
  return path;
}

/** The symlink half: the file's real location is held under the shot directory's real location. */
async function readCapture(root: string, relative: string, field: string): Promise<Uint8Array> {
  const path = shotPath(root, relative, field);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new UltimateError({
      code: 'X_UI_DIFF_FILE_MISSING',
      cause: `${field} names ${path}, and there is no file there`,
      fix: 'x shot / --json   # then diff the image path it answers; a capture ui.shot wrote is listed in its own answer',
      meta: { field, path },
    });
  }
  const real = await realpath(path);
  const shotDir = await realpath(resolve(root, SHOT_DIR));
  if (!under(real, shotDir)) {
    throw new UltimateError({
      code: 'X_UI_DIFF_PATH_OUTSIDE',
      cause: `${field} is a link to ${real}, which is not inside ${shotDir}`,
      fix: SHOT_FIX,
      meta: { field, path, real, shotDir },
    });
  }
  return file.bytes();
}

/**
 * The symlink half for the one path this tool WRITES: `realpath` of the nearest directory that
 * exists above `out`, held under the shot directory's real location — `readCapture`'s rule. The
 * lexical check alone let `.x/shot/<link-to-elsewhere>/diff.png` write wherever the link pointed.
 */
async function assertWritable(root: string, path: string): Promise<void> {
  let dir = dirname(path);
  while (!(await exists(dir)) && dirname(dir) !== dir) dir = dirname(dir);
  const real = await realpath(dir);
  const shotDir = await realpath(resolve(root, SHOT_DIR));
  if (!under(real, shotDir)) {
    throw new UltimateError({
      code: 'X_UI_DIFF_PATH_OUTSIDE',
      cause: `out is under a link to ${real}, which is not inside ${shotDir}`,
      fix: SHOT_FIX,
      meta: { field: 'out', path, real, shotDir },
    });
  }
}

const exists = (dir: string): Promise<boolean> =>
  realpath(dir).then(
    () => true,
    () => false,
  );

// The decode and the pixel rule are `shot-diff.ts`'s, shared with `x shot --against`; re-exported so
// this tool's callers keep one import.
export { decodeCapture, hash8 } from './shot-diff';

export async function diffShots(deps: DiffDeps, input: UiDiffInput): Promise<UiDiffResult> {
  const { root } = deps;
  // The output path is gated BEFORE any decoding: a refusal should cost nothing, and `out` is the
  // one path this tool writes, so it is the one that most needs holding under `.x/shot/`.
  const afterPath = shotPath(root, input.after, 'after');
  const diff =
    input.out === undefined
      ? resolve(dirname(afterPath), `diff-${hash8(input.before)}.png`)
      : shotPath(root, input.out, 'out');
  const [before, after] = await Promise.all([
    readCapture(root, input.before, 'before').then(decodeCapture),
    readCapture(root, input.after, 'after').then(decodeCapture),
  ]);
  if (before.width !== after.width || before.height !== after.height) {
    throw new UltimateError({
      code: 'X_UI_DIFF_SIZE_MISMATCH',
      cause: `before is ${before.width}x${before.height} and after is ${after.width}x${after.height}; a diff needs one size`,
      fix: 'x shot / --json   # photograph both captures at one viewport with one fullPage setting, then diff those two',
      meta: {
        before: { width: before.width, height: before.height },
        after: { width: after.width, height: after.height },
      },
    });
  }
  const result = compareRasters(before, after, input.threshold);
  await assertWritable(root, diff);
  await Bun.write(diff, result.diffPng);
  return {
    ok: true,
    before: input.before,
    after: input.after,
    width: result.width,
    height: result.height,
    changedPixels: result.changedPixels,
    changedPercent: result.changedPercent,
    changedBox: result.changedBox,
    diff,
  };
}
