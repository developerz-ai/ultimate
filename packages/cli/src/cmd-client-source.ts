// Where `x client vendor` reads its document from: `--from` (a file, or an https URL read through
// `outbound({ dial: 'public' })`), else the client's committed `source.json` — so a regeneration
// with no flags is reproducible and offline. One parse, one canonical hash.

// why: Bun ships no path-join primitive.
import { isAbsolute, join } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import { outbound } from '@ultimat3/core/outbound';
import { sha256 } from './client-emit-header';
import { BadFlagError } from './errors';
import { ClientSpecInvalidError } from './openapi-refuse';

/** The longest a vendor's document may take to arrive. */
export const SOURCE_DEADLINE_MS = 30_000;

export interface ClientSource {
  readonly document: unknown;
  /** The document as committed: two-space JSON, so a regeneration rewrites the same bytes. */
  readonly text: string;
}

/**
 * The hash a stamp records: of the PARSED document, so reformatting `source.json` (an editor, the
 * app's Biome) is not a change of contract — only a change of what it says is.
 */
export const sourceHash = (document: unknown): string => sha256(JSON.stringify(document));

export function parseSource(raw: string, label: string): ClientSource {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    // The parser's own message names a character offset in a file the reader did not write.
    throw new ClientSpecInvalidError({ source: label, reason: 'it is not JSON' });
  }
  return { document, text: `${JSON.stringify(document, null, 2)}\n` };
}

/** `--from` as given, or the committed copy at `committed` (app-root-relative). */
export async function readClientSource(input: {
  readonly from: string | undefined;
  readonly cwd: string;
  readonly root: string;
  readonly committed: string;
  readonly name: string;
}): Promise<ClientSource> {
  const { from } = input;
  if (from === undefined) {
    const file = Bun.file(join(input.root, input.committed));
    if (!(await file.exists())) {
      throw new BadFlagError({
        flag: 'from',
        command: 'client vendor',
        reason: `${input.committed} does not exist yet, so there is no document to regenerate from`,
        fix: `x client vendor ${renderFixShellArg(input.name, 'billing')} --from ./openapi.json --json   # the vendor's document, a file or an https URL`,
      });
    }
    return parseSource(await file.text(), input.committed);
  }
  if (/^https?:\/\//.test(from)) {
    const answer = await outbound({
      url: from,
      vendor: input.name,
      dial: 'public',
      deadlineMs: SOURCE_DEADLINE_MS,
      headers: { accept: 'application/json' },
    });
    return parseSource(answer.text(), from);
  }
  const path = isAbsolute(from) ? from : join(input.cwd, from);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new BadFlagError({
      flag: 'from',
      command: 'client vendor',
      reason: `${from} does not exist`,
      fix: `x client vendor ${renderFixShellArg(input.name, 'billing')} --from ./openapi.json --json   # a path from the current directory, or an https URL`,
    });
  }
  return parseSource(await file.text(), from);
}
