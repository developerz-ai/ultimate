// `x doctor`'s warning for an action or query no `defineApi()` lists in an app whose `defineApi()`
// lists others: the scan still serves it (never refused), but the typed client's `Api` lacks it. An
// app that lists none registers by the scan alone, and is told nothing.

// why: Bun has no synchronous exists check and no path API; `posix` because the fix prints an
// import specifier on every OS.
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isAction } from '@ultimat3/action';
import { isQuery } from '@ultimat3/query';
import { loadApp } from './app-load';
import { API_INDEX } from './app-root';
import type { Finding } from './output';
import { camel } from './templates/naming';

/** The load and the modules it imported — the seam a test drives without a scan. */
type ListingLoader = (
  root: string,
) => Promise<{ readonly findings: readonly Finding[]; readonly files?: readonly string[] }>;

type ListKey = 'actions' | 'queries';

/** One primitive a module exports, under the name it serves by. */
interface Exported {
  readonly key: ListKey;
  readonly name: string;
  readonly file: string;
}

/**
 * What `defineApi()` returns: a frozen plain object, one name-keyed map per list. Read by shape,
 * and only once it IS a plain object — an index also exports typed clients, whose property reads
 * are a proxy's and build a transport (one threw X_ENV_MISSING for an unset APP_URL).
 */
const listedIn = (value: unknown, key: ListKey): readonly string[] => {
  if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) return [];
  if (Object.getPrototypeOf(value) !== Object.prototype) return [];
  const api = value as Readonly<Record<string, unknown>>;
  if (!['actions', 'queries', 'jobs', 'tasks'].every((one) => Object.hasOwn(api, one))) return [];
  const list = api[key];
  return typeof list === 'object' && list !== null ? Object.keys(list) : [];
};

/** `refund-ticket.ts` → `refundTicket`: the namespace the index binds, as `x g` names it. */
const aliasOf = (file: string): string => {
  const alias = camel(posix.basename(file).replace(/\.tsx?$/, ''));
  return /^[A-Za-z_]/.test(alias) ? alias : `module${alias}`;
};

/** The import the API index needs, relative to it and without the extension. */
const importLine = (file: string, alias: string): string => {
  const path = posix.relative(posix.dirname(API_INDEX), file).replace(/\.tsx?$/, '');
  return `import * as ${alias} from '${path.startsWith('.') ? path : `./${path}`}';`;
};

/** Pure: one warning per exported primitive whose name no list carries. */
export function unlistedFinding(primitive: Exported): Finding {
  const alias = aliasOf(primitive.file);
  const kind = primitive.key === 'actions' ? 'action' : 'query';
  return {
    code: primitive.key === 'actions' ? 'X_ACTION_UNREGISTERED' : 'X_QUERY_UNREGISTERED',
    cause: `${primitive.name} declared in ${primitive.file} is an ${kind} no defineApi() lists: the module scan still serves it and the manifest carries it, but the typed client's Api does not, and a ${kind === 'action' ? 'job' : 'module'} left off the same list is refused`,
    fix: `${importLine(primitive.file, alias)}   // in ${API_INDEX}, and ${alias} added to ${primitive.key}: [...] there — then x manifest`,
    at: primitive.file,
  };
}

/** Every action and query the loaded modules export, once each, first declaring file kept. */
async function exportedPrimitives(root: string, files: readonly string[]): Promise<Exported[]> {
  const seen = new Set<unknown>();
  const found: Exported[] = [];
  for (const file of files) {
    const module = (await import(join(root, file))) as Readonly<Record<string, unknown>>;
    for (const [exportName, value] of Object.entries(module)) {
      const key: ListKey | undefined = isAction(value)
        ? 'actions'
        : isQuery(value)
          ? 'queries'
          : undefined;
      if (key === undefined || seen.has(value)) continue;
      seen.add(value);
      // The scan names a primitive after its export; one it never reached keeps `''`.
      const name = (value as { readonly name: string }).name || exportName;
      found.push({ key, name, file });
    }
  }
  return found;
}

/**
 * The warnings. Loads the app as every gate step does and says nothing when the load failed (a short
 * registry is the load's finding) or there is no index (nothing to list into). What the index
 * exports from `defineApi()` is the list; a module it imports from a package is listed there too.
 */
export async function unlistedPrimitiveFindings(
  root: string,
  load: ListingLoader = loadApp,
): Promise<readonly Finding[]> {
  const app = await load(root);
  if (app.findings.length > 0 || !existsSync(join(root, API_INDEX))) return [];
  const index = (await import(join(root, API_INDEX))) as Readonly<Record<string, unknown>>;
  const listed = { actions: new Set<string>(), queries: new Set<string>() };
  for (const value of Object.values(index)) {
    for (const key of ['actions', 'queries'] as const) {
      for (const name of listedIn(value, key)) listed[key].add(name);
    }
  }
  // Inconsistency only: an app that lists nothing registers by the scan alone, a supported shape
  // (dummy/social-media-clone), and every warning there would be noise about it.
  if (listed.actions.size === 0 && listed.queries.size === 0) return [];
  return (await exportedPrimitives(root, app.files ?? []))
    .filter((primitive) => !listed[primitive.key].has(primitive.name))
    .map(unlistedFinding);
}
