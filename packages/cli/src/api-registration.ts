// Every generator hands the primitives it wrote to `apps/web/api/index.ts`. The scan registers
// actions and queries by export name on its own and registers NO job: a job module nothing lists
// keeps the positional `anonymous-job-2` that `job()` minted, on the queue row, in
// `x.manifest.json` and in every dead-letter trace — under a green gate (plan 101 slice 11 b).
// Actions and queries are listed for the TYPE: `Api` is what the browser's client is shaped from.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { API_INDEX } from './app-root';
import { containedPath } from './generate-write';
import type { Finding } from './output';
import { camel } from './templates/naming';
import { wrapList } from './templates/wrap';

/** One module to import as a namespace and list under a `defineApi` key. */
export interface ApiEntry {
  readonly key: 'actions' | 'queries' | 'jobs' | 'tasks';
  /** The namespace binding: the file's own name, camelCased — `reindexPost`. */
  readonly binding: string;
  /** From `apps/web/api/`: `../app/post/jobs/reindex-post`. */
  readonly specifier: string;
}

const PRIMITIVE_PATH =
  /^apps\/web\/(?<rest>[^/]+\/[^/]+\/(?<dir>actions|queries|live|jobs|tasks)\/(?<file>[a-z0-9-]+))\.ts$/;

/** The order `x new` writes the lists in, which a list this adds keeps. */
const LIST_ORDER: readonly ApiEntry['key'][] = ['actions', 'queries', 'jobs', 'tasks'];

/**
 * The `defineApi` list each generated directory belongs in. `actions/` holds mutators too, and a
 * mutator IS an action — `defineApi` merges both lists into one registration — so one key serves.
 */
const KEY_OF: Readonly<Record<string, ApiEntry['key']>> = {
  actions: 'actions',
  queries: 'queries',
  live: 'queries',
  jobs: 'jobs',
  tasks: 'tasks',
};

/**
 * The primitive modules among the paths a generator wrote. Tests are not modules to list.
 *
 * Actions and queries too, though the scan registers those at boot without being told: `Api` —
 * the type the browser's typed client is shaped from — is `typeof defineApi({ … })`, so one the
 * index does not list is an endpoint the page has no typed call for.
 */
export function apiEntriesFor(written: readonly string[]): readonly ApiEntry[] {
  return written.flatMap((path) => {
    const groups = PRIMITIVE_PATH.exec(path)?.groups;
    if (groups === undefined) return [];
    const { rest = '', dir, file = '' } = groups;
    const key = dir !== undefined && Object.hasOwn(KEY_OF, dir) ? KEY_OF[dir] : undefined;
    return key === undefined ? [] : [{ key, binding: camel(file), specifier: `../${rest}` }];
  });
}

/**
 * Every `[...]` entry of a `key: [...]` list in the `defineApi({ ... })` call, and where it sits:
 * `line` is the start of the line holding `key: [`, `start` is just past the `[`, `end` is the `]`.
 *
 * Searched from `from` (the `defineApi({` call), so a `jobs: [` in a comment or an object above the
 * call is never the one edited. `line` is found from the key, never from `start`: in a list already
 * wrapped one entry per line the character AT `start` is the newline after `[`, and a backwards
 * search from there answered the first ITEM's line — the rewrite then nested a second `jobs: [`
 * inside the first and left the old `]` behind.
 */
const listOf = (
  source: string,
  key: string,
  from: number,
): { line: number; start: number; end: number; items: string[] } | undefined => {
  const open = new RegExp(`\\n([ \\t]*)${key}: \\[`, 'g');
  open.lastIndex = from;
  const found = open.exec(source);
  if (found === null) return undefined;
  const line = found.index + 1;
  const start = found.index + found[0].length;
  const end = source.indexOf(']', start);
  if (end === -1) return undefined;
  const items = source
    .slice(start, end)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return { line, start, end, items };
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
    const actions = call === -1 ? undefined : listOf(next, 'actions', call);
    if (call === -1 || actions === undefined) {
      skipped.push(entry);
      continue;
    }
    const list = listOf(next, entry.key, call);
    if (list?.items.includes(entry.binding) === true) continue;
    if (list === undefined) {
      // In the order `x new` writes — actions, queries, jobs, tasks: after the nearest list
      // before it that the call already holds, which is `actions` at the least.
      const earlier = LIST_ORDER.slice(0, LIST_ORDER.indexOf(entry.key))
        .map((key) => listOf(next, key, call))
        .findLast((found) => found !== undefined);
      const after = next.indexOf('\n', (earlier ?? actions).end);
      const line = `  ${entry.key}: [${entry.binding}],`;
      next = `${next.slice(0, after + 1)}${line}\n${next.slice(after + 1)}`;
    } else {
      const items = [...list.items, entry.binding];
      const indent = /^[ \t]*/.exec(next.slice(list.line))?.[0] ?? '';
      const rewritten = wrapList(indent, `${entry.key}: [`, items, ']');
      next = `${next.slice(0, list.line)}${rewritten}${next.slice(list.end + 1)}`;
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

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Every binding an import clause declares: `* as x`, `x`, `{ a, b as c, type d }`. */
const clauseBindings = (clause: string): readonly string[] =>
  clause
    .replace(/^type\s+/, '')
    .replace(/[{}]/g, ',')
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, '')
        .replace(/^\*\s+as\s+/, ''),
    )
    .map(
      (part) =>
        part
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? '',
    )
    .filter((name) => IDENTIFIER.test(name));

/**
 * Every top-level name the index declares, and what holds it: a namespace import by its
 * specifier, anything else (`defineApi`, `api`, `Api`, a named import) by its own name. A second
 * binding of any of them is a module that does not load — `import * as api` beside
 * `export const api` is a ReferenceError in every app-loading command.
 */
function declaredBindings(source: string): ReadonlyMap<string, string> {
  const held = new Map<string, string>();
  for (const found of source.matchAll(/^import\s+([^;]*?)\s+from\s+'([^']+)';/gm)) {
    const [, clause = '', specifier = ''] = found;
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause.trim())?.[1];
    if (namespace !== undefined) held.set(namespace, specifier);
    else for (const name of clauseBindings(clause)) held.set(name, `an import from ${specifier}`);
  }
  const declaration =
    /^(?:export\s+)?(?:declare\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const found of source.matchAll(declaration)) {
    const [, name = ''] = found;
    if (!held.has(name)) held.set(name, `the index's own ${name}`);
  }
  return held;
}

/**
 * A written primitive whose namespace binding the index already holds — for another module, or as
 * one of its own names — is a finding, decided BEFORE anything is written. Skipped silently, the
 * job stayed unregistered under a green run; inserted, the index stopped loading.
 */
export function apiBindingFindings(
  source: string,
  written: readonly string[],
  fix: string,
): readonly Finding[] {
  const held = new Map(declaredBindings(source));
  const findings: Finding[] = [];
  for (const entry of apiEntriesFor(written)) {
    const holder = held.get(entry.binding);
    if (holder === entry.specifier) continue;
    if (holder === undefined) {
      held.set(entry.binding, entry.specifier);
      continue;
    }
    findings.push({
      code: 'X_GENERATE_CONFLICT',
      cause: `${API_INDEX} binds every listed module under its file name, and "${entry.binding}" is already ${holder.startsWith('.') ? `the namespace of ${holder}` : holder} — ${entry.specifier} cannot be listed under it`,
      fix,
      docs: ERROR_DOCS_URL,
      at: API_INDEX,
    });
  }
  return findings;
}

/** `apiBindingFindings` against the app's own index; none when the app has no index. */
export async function indexBindingFindings(
  root: string,
  written: readonly string[],
  fix: string,
): Promise<readonly Finding[]> {
  const file = containedPath(root, API_INDEX);
  if (!(await Bun.file(file).exists())) return [];
  return apiBindingFindings(await Bun.file(file).text(), written, fix);
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
