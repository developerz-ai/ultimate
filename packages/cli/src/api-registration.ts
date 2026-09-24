// `x g job` / `x g task` / `x g resource` hand what they wrote to `apps/web/api/index.ts`. The scan
// registers actions and queries by export name on its own and registers NO job: a job module
// nothing lists keeps the positional `anonymous-job-2` that `job()` minted, on the queue row, in
// `x.manifest.json` and in every dead-letter trace — under a green gate (plan 101 slice 11 b).

import { containedPath } from './generate-write';
import { camel } from './templates/naming';
import { wrapList } from './templates/wrap';

/** The one file `defineApi` is called from in a scaffolded app. */
export const API_INDEX = 'apps/web/api/index.ts';

/** One module to import as a namespace and list under a `defineApi` key. */
export interface ApiEntry {
  readonly key: 'jobs' | 'tasks';
  /** The namespace binding: the file's own name, camelCased — `reindexPost`. */
  readonly binding: string;
  /** From `apps/web/api/`: `../app/post/jobs/reindex-post`. */
  readonly specifier: string;
}

const PRIMITIVE_PATH =
  /^apps\/web\/(?<rest>[^/]+\/[^/]+\/(?<dir>jobs|tasks)\/(?<file>[a-z0-9-]+))\.ts$/;

/** The job and task modules among the paths a generator wrote. Tests are not modules to list. */
export function apiEntriesFor(written: readonly string[]): readonly ApiEntry[] {
  return written.flatMap((path) => {
    const groups = PRIMITIVE_PATH.exec(path)?.groups;
    if (groups === undefined) return [];
    const { rest = '', dir, file = '' } = groups;
    return [
      { key: dir === 'tasks' ? 'tasks' : 'jobs', binding: camel(file), specifier: `../${rest}` },
    ];
  });
}

/** Every `[...]` entry of a `key: [...]` list in the `defineApi({ ... })` call. */
const listOf = (
  source: string,
  key: string,
): { start: number; end: number; items: string[] } | undefined => {
  const open = new RegExp(`\\n(\\s*)${key}: \\[`).exec(source);
  if (open === null) return undefined;
  const start = open.index + open[0].length;
  const end = source.indexOf(']', start);
  if (end === -1) return undefined;
  const items = source
    .slice(start, end)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return { start, end, items };
};

/**
 * `source` with each entry imported and listed. The import joins the `import * as` block in sorted
 * position; the binding joins its list, which is created after `actions: [...]` when the call has
 * none. An index that is not the scaffold's shape — no `defineApi({`, no `actions:` list — is
 * returned untouched with the entries in `skipped`, and the `manifest` step's X_JOB_UNREGISTERED
 * names the edit.
 */
export function insertApiEntries(
  source: string,
  entries: readonly ApiEntry[],
): { readonly source: string; readonly skipped: readonly ApiEntry[] } {
  let next = source;
  const skipped: ApiEntry[] = [];
  for (const entry of entries) {
    const importLine = `import * as ${entry.binding} from '${entry.specifier}';`;
    const call = next.indexOf('defineApi({');
    const actions = listOf(next, 'actions');
    if (call === -1 || actions === undefined) {
      skipped.push(entry);
      continue;
    }
    const list = listOf(next, entry.key);
    if (list?.items.includes(entry.binding) === true) continue;
    if (list === undefined) {
      // After `actions: [...],` — the order `x new` writes: actions, queries, jobs, tasks.
      const after = next.indexOf('\n', actions.end);
      const line = `  ${entry.key}: [${entry.binding}],`;
      next = `${next.slice(0, after + 1)}${line}\n${next.slice(after + 1)}`;
    } else {
      const items = [...list.items, entry.binding];
      const lineStart = next.lastIndexOf('\n', list.start) + 1;
      const indent = /^\s*/.exec(next.slice(lineStart))?.[0] ?? '';
      const rewritten = wrapList(indent, `${entry.key}: [`, items, ']');
      next = `${next.slice(0, lineStart)}${rewritten}${next.slice(list.end + 1)}`;
    }
    if (!next.includes(importLine)) next = withImport(next, importLine);
  }
  return { source: next, skipped };
}

/**
 * The import, in the `import * as` block Biome keeps sorted by specifier. Placed before the first
 * relative import whose specifier sorts after it, or after the last one.
 */
function withImport(source: string, importLine: string): string {
  const specifier = /from '([^']+)'/.exec(importLine)?.[1] ?? '';
  const lines = source.split('\n');
  const relative = lines
    .map((line, index) => ({ line, index, from: /^import .* from '(\.[^']*)';$/.exec(line)?.[1] }))
    .filter((row) => row.from !== undefined);
  const before = relative.find((row) => (row.from ?? '') > specifier);
  const at = before?.index ?? (relative.at(-1)?.index ?? -1) + 1;
  lines.splice(at, 0, importLine);
  return lines.join('\n');
}

/** Performs `insertApiEntries` on the app's index. Answers the paths it rewrote. */
export async function registerGeneratedPrimitives(
  root: string,
  written: readonly string[],
): Promise<readonly string[]> {
  const entries = apiEntriesFor(written);
  const file = containedPath(root, API_INDEX);
  if (entries.length === 0 || !(await Bun.file(file).exists())) return [];
  const before = await Bun.file(file).text();
  const { source } = insertApiEntries(before, entries);
  if (source === before) return [];
  await Bun.write(file, source);
  return [API_INDEX];
}
