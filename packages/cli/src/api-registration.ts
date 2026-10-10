// Every generator hands the primitives it wrote to `apps/web/api/index.ts`. The scan registers
// actions and queries by export name on its own and registers NO job: a job module nothing lists
// keeps the positional `anonymous-job-2` that `job()` minted, on the queue row, in
// `x.manifest.json` and in every dead-letter trace — under a green gate (plan 101 slice 11 b).
// Actions and queries are listed for the TYPE: `Api` is what the browser's client is shaped from.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { API_INDEX } from './app-root';
import type { GenerateDisk } from './generate-disk';
import { appDisk } from './generate-disk';
import { containedPath } from './generate-write';
import type { Finding } from './output';
import type { SourceList } from './source-list-edit';
import { appendToList, maskOf, readList, readProperties } from './source-list-edit';
import { camel } from './templates/naming';

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
 * The `key: [...]` lists of the `defineApi({ ... })` call, read off the MASKED text: a `jobs: [` in
 * a comment or an object above the call is never the one edited, and a `]` or a comma inside a
 * comment between two entries ends nothing. (The list was closed at the first `]` in the raw text
 * and split at every comma — a commented list was rewritten with its comment as an entry.)
 */
const listsOf = (source: string): ((key: string) => SourceList | undefined) | undefined => {
  const masked = maskOf(source);
  const call = /\bdefineApi\(\s*\{/.exec(masked);
  if (call === null) return undefined;
  const properties = readProperties(source, masked, call.index + call[0].length - 1);
  return (key) => {
    const property = properties.find((one) => one.key === key);
    return property === undefined || masked[property.value] !== '['
      ? undefined
      : readList(source, masked, property.value);
  };
};

/**
 * `source` with each entry imported and listed. The import joins the `import * as` block in sorted
 * position; the binding joins its list, which is created after `actions: [...]` when the call has
 * none. An index that is not the scaffold's shape — no `defineApi({`, no `actions:` list — or a
 * list that cannot be edited safely is returned untouched with the entries in `skipped`, and the
 * `manifest` step's X_JOB_UNREGISTERED names the edit.
 */
export function insertApiEntries(
  source: string,
  entries: readonly ApiEntry[],
): { readonly source: string; readonly skipped: readonly ApiEntry[] } {
  let next = source;
  const skipped: ApiEntry[] = [];
  for (const entry of entries) {
    const importLine = `import * as ${entry.binding} from '${entry.specifier}';`;
    const listOf = listsOf(next);
    const actions = listOf?.('actions');
    if (listOf === undefined || actions === undefined) {
      skipped.push(entry);
      continue;
    }
    const list = listOf(entry.key);
    if (list?.entries.some((one) => one.text === entry.binding) === true) continue;
    if (list === undefined) {
      // In the order `x new` writes — actions, queries, jobs, tasks: after the nearest list
      // before it that the call already holds, which is `actions` at the least.
      const earlier = LIST_ORDER.slice(0, LIST_ORDER.indexOf(entry.key))
        .map((key) => listOf(key))
        .findLast((found) => found !== undefined);
      const after = next.indexOf('\n', (earlier ?? actions).close);
      const line = `  ${entry.key}: [${entry.binding}],`;
      next = `${next.slice(0, after + 1)}${line}\n${next.slice(after + 1)}`;
    } else {
      const edited = appendToList(next, list.open, [entry.binding]);
      if (edited === undefined) {
        skipped.push(entry);
        continue;
      }
      next = edited;
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
  disk: GenerateDisk = appDisk(root),
): Promise<readonly string[]> {
  const entries = apiEntriesFor(written);
  const before = entries.length === 0 ? undefined : await disk.read(API_INDEX);
  if (before === undefined) return [];
  const { source } = insertApiEntries(before, entries);
  if (source === before) return [];
  await disk.write(API_INDEX, source);
  return [API_INDEX];
}
