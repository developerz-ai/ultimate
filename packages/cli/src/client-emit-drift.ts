// The `drift` step's client rail: every file `x client` wrote, read back against its own stamp. A
// source document whose content moved is `X_CLIENT_STALE`; a body whose bytes moved is
// `X_CLIENT_EDITED`. The stamp is the convention's build error — no file is trusted on its name.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { ERROR_DOCS_URL, timingSafeEqual } from '@ultimat3/core';
import { readStamp, STAMP_MARKER, sha256 } from './client-emit-header';
import { sourceHash } from './cmd-client-source';
import type { Finding } from './output';
import { eachSourceFile, isVendored } from './source-files';

/** Vendor clients live here; customer clients wherever `--out` put them inside the source globs. */
const CLIENT_GLOB = 'apps/*/clients/**/*.ts';

/** How much of a file is read to look for a stamp: the header is the first three lines. */
const HEAD_BYTES = 600;

async function candidates(root: string): Promise<readonly string[]> {
  const paths = new Set<string>();
  for await (const path of new Bun.Glob(CLIENT_GLOB).scan({ cwd: root, absolute: false })) {
    if (!isVendored(path)) paths.add(path.replace(/\\/g, '/'));
  }
  for await (const path of eachSourceFile(root)) paths.add(path);
  return [...paths].sort();
}

/** The source's hash now, or `undefined` when it is gone or no longer JSON. */
async function currentHash(root: string, source: string): Promise<string | undefined> {
  const file = Bun.file(join(root, source));
  if (source === '' || !(await file.exists())) return undefined;
  try {
    return sourceHash(JSON.parse(await file.text()));
  } catch {
    // Unparseable is "not the document the client was compiled from" — the stale finding says so.
    return undefined;
  }
}

export async function checkClientDrift(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const hashes = new Map<string, string | undefined>();
  for (const path of await candidates(root)) {
    const file = Bun.file(join(root, path));
    if (!(await file.slice(0, HEAD_BYTES).text()).includes(STAMP_MARKER)) continue;
    const read = readStamp(await file.text());
    if (read === undefined) continue;
    const { stamp, body } = read;
    const fix = `${stamp.command === '' ? 'x client --help' : stamp.command} --json`;
    if (!timingSafeEqual(sha256(body), stamp.bodyHash)) {
      findings.push({
        code: 'X_CLIENT_EDITED',
        cause: `${path} no longer matches the hash in its own stamp: it was edited by hand, and the next regeneration discards that edit`,
        fix: `${fix}   # then keep the change in a file of your own that wraps this client`,
        docs: ERROR_DOCS_URL,
        at: path,
      });
      continue;
    }
    if (!hashes.has(stamp.source)) hashes.set(stamp.source, await currentHash(root, stamp.source));
    if (!timingSafeEqual(hashes.get(stamp.source) ?? '', stamp.sourceHash)) {
      findings.push({
        code: 'X_CLIENT_STALE',
        cause: `${path} was compiled from a ${stamp.source} that has since changed, so it calls the old contract`,
        fix,
        docs: ERROR_DOCS_URL,
        at: path,
      });
    }
  }
  return findings;
}
