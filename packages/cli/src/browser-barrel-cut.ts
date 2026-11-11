// The browser graph's cuts over an app on disk: what each browser entry really exports (read from
// the installed manifest, so a promised swap compiles), one `X_BROWSER_SERVER_BARREL` per edge to
// delete, and the cut as `x fix boundary` prints it. The `boundaries` step (`app-transport.ts`) and
// `x fix boundary` both read from here, so the gate and the command cannot disagree.

// why: Bun ships no path joiner; the manifest and the entry are read at a joined path.
import { join } from 'node:path';
import { isJsonObject } from '@ultimat3/core';
import { exportedNames } from './browser-import-chain';
import type { Finding, JsonValue } from './output';

const CODE = 'X_BROWSER_SERVER_BARREL';

/** What `@scope/pkg/sub` exports, read through the app's `node_modules`; `undefined` = unknown. */
export async function publishedNames(
  root: string,
  spec: string,
): Promise<ReadonlySet<string> | undefined> {
  const match = /^(@[\w.-]+\/[\w.-]+)\/([\w.-]+)$/.exec(spec);
  if (match === null) return undefined;
  const dir = join(root, 'node_modules', match[1] ?? '');
  try {
    const manifest: unknown = await Bun.file(join(dir, 'package.json')).json();
    const exports = isJsonObject(manifest) ? manifest['exports'] : undefined;
    const row = isJsonObject(exports) ? exports[`./${match[2]}`] : undefined;
    const target = isJsonObject(row) ? (row['import'] ?? row['default']) : row;
    if (typeof target !== 'string') return undefined;
    return exportedNames(await Bun.file(join(dir, target)).text());
  } catch {
    return undefined;
  }
}

const strings = (value: JsonValue | undefined): readonly string[] | undefined =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')
    ? (value as readonly string[])
    : undefined;

/** One finding per edit: every site one cut clears is listed on it, never printed again. */
export function mergeBarrelFindings(findings: readonly Finding[]): readonly Finding[] {
  const byEdit = new Map<string, Finding>();
  const out: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.at ?? ''}\u0000${finding.fix}`;
    const held = byEdit.get(key);
    if (finding.code !== CODE || held === undefined) {
      if (finding.code === CODE) byEdit.set(key, finding);
      out.push(finding);
      continue;
    }
    const sites = [...(strings(held.meta?.['sites']) ?? [])];
    for (const one of strings(finding.meta?.['sites']) ?? [])
      if (!sites.includes(one)) sites.push(one);
    const grown: Finding = { ...held, meta: { ...held.meta, sites } };
    byEdit.set(key, grown);
    out[out.indexOf(held)] = grown;
  }
  return out.map((finding) => {
    const sites = strings(finding.meta?.['sites']) ?? [];
    return finding.code === CODE && sites.length > 1
      ? {
          ...finding,
          cause: `${finding.cause}; the same edge also reaches ${sites.slice(1).join(', ')}`,
        }
      : finding;
  });
}

/** Every browser entry's export names that could be read; an entry left out is unknown. */
export async function publishedEntries(
  root: string,
  entries: Iterable<string>,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const read = await Promise.all(
    [...new Set(entries)].map(async (entry) => [entry, await publishedNames(root, entry)] as const),
  );
  return new Map(read.flatMap(([entry, names]) => (names === undefined ? [] : [[entry, names]])));
}

/** The browser-graph findings `x fix boundary <target>` owns: its island, or any file on the chain. */
export const involvesTarget = (finding: Finding, target: string): boolean =>
  finding.code === CODE &&
  (finding.at?.split(':')[0] === target ||
    (strings(finding.meta?.['chain']) ?? []).includes(target));

/**
 * A browser-graph cut as `x fix boundary`'s `data.cuts` carries a surface one: the edge is the
 * entry's first hop for a cut, the barrel import itself for a swap.
 */
export function browserCutJson(finding: Finding): JsonValue {
  const meta = finding.meta ?? {};
  const chain = strings(meta['chain']) ?? [];
  const [site = ''] = strings(meta['sites']) ?? [];
  const entry = chain[0] ?? '';
  const edge =
    meta['cut'] === 'entry'
      ? { from: entry, to: chain[1] ?? '' }
      : { from: site.replace(/:\d+$/, ''), to: String(meta['barrel'] ?? '') };
  return {
    code: finding.code,
    rule: 'browser-server-barrel',
    entry,
    at: finding.at ?? '',
    edge,
    chain: [...chain],
    edit: finding.fix,
    split: null,
  };
}
