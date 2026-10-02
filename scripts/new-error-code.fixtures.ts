// The throwaway root both halves of the generator's test read: copies of real registrations, the
// real `wiki/Error-Codes.md` and the two files that decide a code's HTTP status — never the
// committed ones. Shared so `new-error-code.test.ts` and `new-error-code-status.test.ts` prove
// their refusals against the same tree.

import { expect } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { STATUS_BACKLOG, STATUS_TABLE, WIKI_PAGE } from './new-error-code';

export const ROOT = repoRoot();
const made: string[] = [];
/**
 * Each test file registers this itself (`afterAll(removeFixtureRoots)`): a module is evaluated
 * once per process, so an `afterAll` written HERE would belong to whichever file imported it first.
 */
export async function removeFixtureRoots(): Promise<void> {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** A root with the real money and seo registrations, a query one in no known shape, and the page. */
export async function fixtureRoot(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/new-error-code-`);
  made.push(dir);
  for (const pkg of ['money', 'seo']) {
    await mkdir(`${dir}/packages/${pkg}/src`, { recursive: true });
    await Bun.write(
      `${dir}/packages/${pkg}/src/errors.ts`,
      Bun.file(`${ROOT}/packages/${pkg}/src/errors.ts`),
    );
  }
  await mkdir(`${dir}/packages/odd/src`, { recursive: true });
  await Bun.write(
    `${dir}/packages/odd/src/errors.ts`,
    "export const odd = new Map([['X_ODD', 't']]);\n",
  );
  await mkdir(`${dir}/wiki`, { recursive: true });
  await Bun.write(`${dir}/${WIKI_PAGE}`, Bun.file(`${ROOT}/${WIKI_PAGE}`));
  // The two files that decide a code's HTTP status, real copies: a row here or a pin there.
  for (const file of [STATUS_TABLE, STATUS_BACKLOG]) {
    await Bun.write(`${dir}/${file}`, Bun.file(`${ROOT}/${file}`));
  }
  return dir;
}

export const read = (dir: string, path: string): Promise<string> =>
  Bun.file(`${dir}/${path}`).text();
export const refusal = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => expect.unreachable('the generator wrote where it had to refuse'),
    (error: unknown) => (error instanceof ScriptError ? error.code : `not a ScriptError`),
  );
export const transpiles = (source: string): boolean => {
  try {
    new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
    return true;
  } catch {
    return false;
  }
};
