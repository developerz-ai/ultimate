// Write one planned file to disk: bytes through `Bun.write`, a `link` entry as a relative symlink.
// The copy fallback is Windows-only, where creating a symlink needs Developer Mode or an elevated
// token and `symlink` fails with EPERM; anywhere else a failed link is a real error and surfaces.

// why: Bun ships no symlink or mkdir API, nor a path API to find the link's parent directory.
import { mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GeneratedFile } from './templates';

/** The OS refusing the privilege, not the call being wrong: only these fall back to a copy. */
const PRIVILEGE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS']);

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

export interface WriteGeneratedSeams {
  readonly link?: (target: string, path: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
}

/** `'link'` when a symlink landed, `'copy'` when Windows refused one and the text was written. */
export async function writeGenerated(
  root: string,
  file: GeneratedFile,
  seams: WriteGeneratedSeams = {},
): Promise<'file' | 'link' | 'copy'> {
  const path = join(root, file.path);
  if (file.merge !== undefined || file.link === undefined) {
    await Bun.write(path, file.contents);
    return 'file';
  }
  // `'file'`: Windows cannot infer the kind of a target written after its link.
  const link = seams.link ?? ((target: string, at: string) => symlink(target, at, 'file'));
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  try {
    await link(file.link, path);
    return 'link';
  } catch (error) {
    const windows = (seams.platform ?? process.platform) === 'win32';
    if (!windows || !PRIVILEGE_CODES.has(codeOf(error) ?? '')) throw error;
    await Bun.write(path, file.contents);
    return 'copy';
  }
}
