// `x g sign-in`'s two runtime files, rebased onto what the app has: the template's pair replaces
// `x new`'s bytes, and an edited copy gets only the sign-in delta spliced in
// (`templates/sign-in-runtime.ts`). The spliced file is handed to the one writer as a replacement
// of the exact bytes read here, so a file changed between this read and the write still conflicts.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { GenerateDisk } from './generate-disk';
import type { Finding } from './output';
import type { GeneratedFile } from './templates/naming';
import { RUNTIME_MODULE, RUNTIME_TEST } from './templates/scaffold-runtime-ports';
import {
  type RuntimeRoutes,
  type RuntimeSplice,
  spliceSignInRuntime,
  spliceSignInRuntimeTest,
} from './templates/sign-in-runtime';

export interface RebasedRuntime {
  readonly files: readonly GeneratedFile[];
  /** A runtime file the splice could not read: the run is refused, naming the line to edit. */
  readonly refusals: readonly Finding[];
}

const unrecognisedFinding = (
  path: string,
  splice: Extract<RuntimeSplice, { kind: 'unrecognised' }>,
  invocation: string,
): Finding => ({
  code: 'X_GENERATE_CONFLICT',
  cause: `${path} is the author's, and x g sign-in found no place in it to add what sign-in needs, so nothing was written`,
  fix: `edit ${path}:${splice.line} — ${splice.edit}; then: ${invocation}`,
  docs: ERROR_DOCS_URL,
  at: path,
});

/**
 * `files` with each runtime entry spliced over the copy on disk. A file already holding the
 * sign-in delta is left as the template's entry, so the writer reports the conflict a second run
 * always was; a test the shape adds nothing to is dropped from the run.
 */
export async function rebaseSignInRuntime(
  disk: GenerateDisk,
  files: readonly GeneratedFile[],
  routes: RuntimeRoutes | undefined,
  invocation: string,
): Promise<RebasedRuntime> {
  const out: GeneratedFile[] = [];
  const refusals: Finding[] = [];
  for (const file of files) {
    const isRuntime = file.path === RUNTIME_MODULE || file.path === RUNTIME_TEST;
    const now = isRuntime ? await disk.read(file.path) : undefined;
    if (now === undefined || file.merge !== 'replaces-pristine') {
      out.push(file);
      continue;
    }
    const splice =
      file.path === RUNTIME_MODULE
        ? spliceSignInRuntime(now, routes)
        : spliceSignInRuntimeTest(now, routes);
    if (splice.kind === 'unrecognised') {
      refusals.push(unrecognisedFinding(file.path, splice, invocation));
      out.push(file);
    } else if (splice.kind === 'present') {
      out.push(file);
    } else if (splice.source !== now) {
      out.push({ ...file, contents: splice.source, pristine: now });
    }
  }
  return { files: out, refusals };
}
