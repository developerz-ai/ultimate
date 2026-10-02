// The gate's half of per-role loading (`manifest` step): a worker and a scheduler import the API
// index and every module that reaches no component or stylesheet (`role-load.ts`). A registration
// made in a module that DOES reach one, and that the index does not import, exists in the web role
// and in every tool — and not in a worker. At boot only jobs and tasks are checked, against the
// manifest; this is the build error for everything else a job reads by name.

// why: Bun ships no path API; the fix names the import relative to the API index.
import { dirname, join, relative } from 'node:path';
import { ERROR_DOCS_URL, registeredServiceNames, singleLine } from '@ultimat3/core';
import { entityNames } from '@ultimat3/entity';
import { catalogDeclarationCount } from '@ultimat3/i18n';
import { registeredBackfills, registeredJobs, registeredTasks } from '@ultimat3/jobs';
import { registeredLayouts, registeredMailIds } from '@ultimat3/mail';
import { registeredChannels } from '@ultimat3/realtime';
import { definedStorage } from '@ultimat3/storage';
import { API_INDEX } from './app-root';
import type { Runner } from './exec';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** One thing a process registered, as a job would ask for it: by kind and by name. */
export interface Registration {
  readonly kind: string;
  readonly name: string;
}

/** A registration the whole app makes and the background load does not, and the module it took. */
export interface MissingRegistration extends Registration {
  /** App-root-relative: the scanned module whose import registered it. */
  readonly module: string;
}

/**
 * Every name-keyed registry a job body can read without importing the declaration: what
 * `ctx.<service>`, `disk('x')`, `t('key')`, a mail layout or a channel resolves through. A
 * registry read only through a static import of its declaration is not here — the import loads it.
 */
export function registrations(): readonly Registration[] {
  const of = (kind: string, names: readonly string[]): readonly Registration[] =>
    names.map((name) => ({ kind, name }));
  return [
    ...of('service', registeredServiceNames()),
    ...of('storage disk', definedStorage()?.diskNames ?? []),
    // A catalog declaration carries no name of its own: the count is what a module adds to.
    ...of(
      'catalog declaration',
      Array.from({ length: catalogDeclarationCount() }, (_, at) => `#${String(at + 1)}`),
    ),
    ...of('entity', entityNames()),
    ...of(
      'job',
      registeredJobs().map((job) => job.name),
    ),
    ...of(
      'task',
      registeredTasks().map((task) => task.name),
    ),
    ...of(
      'backfill',
      registeredBackfills().map((backfill) => backfill.name),
    ),
    ...of('mail', registeredMailIds()),
    ...of('mail layout', registeredLayouts()),
    ...of(
      'channel',
      registeredChannels().map((channel) => channel.name),
    ),
  ];
}

const keyOf = (one: Registration): string => `${one.kind}\u0000${one.name}`;

/** What `after` holds that `before` did not. */
export function registeredSince(
  before: readonly Registration[],
  after: readonly Registration[],
): readonly Registration[] {
  const had = new Set(before.map(keyOf));
  return after.filter((one) => !had.has(keyOf(one)));
}

/** The import the API index is missing, as it would be written there. */
function specifierFor(module: string): string {
  const from = relative(dirname(API_INDEX), module).replace(/\.[jt]sx?$/, '');
  return from.startsWith('.') ? from : `./${from}`;
}

export function roleLoadFinding(missing: MissingRegistration): Finding {
  return {
    code: 'X_ROLE_LOAD_INCOMPLETE',
    cause: `${missing.kind} ${JSON.stringify(missing.name)} is registered by importing ${missing.module}, which reaches a component or a stylesheet and which ${API_INDEX} does not import — so a worker and a scheduler, which import no document, run without it`,
    fix: `edit ${API_INDEX}: add import '${specifierFor(missing.module)}'; — or move the ${missing.kind} out of ${missing.module} into a module that imports no .tsx and no stylesheet`,
    docs: ERROR_DOCS_URL,
    at: missing.module,
  };
}

/** The line the probe prints its answer on; everything else it writes is a module's own output. */
export const PROBE_MARKER = 'x-role-load-probe:';

const PROBE = join(import.meta.dir, 'verify-role-load-probe.ts');

const isMissing = (value: unknown): value is MissingRegistration => {
  if (typeof value !== 'object' || value === null) return false;
  const one = value as Record<string, unknown>;
  return (
    typeof one['kind'] === 'string' &&
    typeof one['name'] === 'string' &&
    typeof one['module'] === 'string'
  );
};

/** The probe's answer off its stdout — `undefined` when it printed none. */
export function parseProbe(stdout: string): readonly MissingRegistration[] | undefined {
  const line = stdout
    .split('\n')
    .reverse()
    .find((one) => one.startsWith(PROBE_MARKER));
  if (line === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(PROBE_MARKER.length));
    return Array.isArray(parsed) && parsed.every(isMissing) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One child, because the comparison needs a process whose registries hold ONLY what the background
 * load put there — this one has already imported the whole app. The child imports what a worker
 * imports, then the rest module by module, and answers what each of those added.
 */
export async function roleLoadFindings(root: string, runner: Runner): Promise<readonly Finding[]> {
  const result = await runner(['bun', PROBE, root], { cwd: root });
  const missing = parseProbe(result.stdout);
  if (missing !== undefined) return missing.map(roleLoadFinding);
  // No answer is not a pass: the load a worker performs did not complete in a clean process.
  const said = singleLine(result.stderr.trim().split('\n').at(-1) ?? '');
  return [
    {
      code: 'X_ROLE_LOAD_INCOMPLETE',
      cause: `the worker's load of this app did not complete in a process of its own (exit ${String(result.code)}${said === '' ? '' : `: ${said}`}), so what a worker registers could not be compared with the whole app`,
      fix: `bun ${quoteArg(PROBE)} ${quoteArg(root)}`,
      docs: ERROR_DOCS_URL,
      at: API_INDEX,
    },
  ];
}
