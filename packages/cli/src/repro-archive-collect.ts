// Single responsibility: the reads `x repro --bundle` makes beyond the subject — the installed
// `@ultimat3/*` versions, what the scrubber must hide (dotenv values, config hostnames, the home
// directory, the machine's name), the error's cause and stack, and the app's declarations by name.

// why: Bun exposes neither the home directory nor the machine's hostname.
import { homedir, hostname } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { getAction } from '@ultimat3/action';
import { postgresErrorGroupsStore } from '@ultimat3/admin/error-groups';
import { isJsonObject } from '@ultimat3/core';
import { getEntity, sealedFields } from '@ultimat3/entity';
import type { JobDriver } from '@ultimat3/jobs';
import { getJob, inspectJob } from '@ultimat3/jobs';
import { getQuery } from '@ultimat3/query';
import { appConfigExport } from './app-config-load';
import type { ReproErrorFacts } from './repro-archive';
import type { ReproSubject } from './repro-bundle';
import type { ReproLookups } from './repro-redact';
import type { ScrubSources } from './repro-scrub';
import { hostOf } from './repro-scrub';
import { parseDotenv } from './root-env';

/** Where an installed `@ultimat3/*` manifest sits: the root, a workspace, or Bun's isolated store. */
const MANIFEST_GLOBS = [
  'node_modules/@ultimat3/*/package.json',
  '{apps,packages}/*/node_modules/@ultimat3/*/package.json',
  'node_modules/.bun/*/node_modules/@ultimat3/*/package.json',
];

/** Every installed `@ultimat3/*` package and the versions found of it, names and versions sorted. */
export async function installedFramework(root: string): Promise<Record<string, string[]>> {
  const found = new Map<string, Set<string>>();
  for (const pattern of MANIFEST_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, dot: true })) {
      const parsed: unknown = await Bun.file(join(root, path))
        .json()
        .catch(() => undefined);
      if (!isJsonObject(parsed)) continue;
      const { name, version } = parsed;
      if (typeof name !== 'string' || typeof version !== 'string') continue;
      if (!name.startsWith('@ultimat3/')) continue;
      found.set(name, (found.get(name) ?? new Set()).add(version));
    }
  }
  return Object.fromEntries(
    [...found.keys()].sort().map((name) => [name, [...(found.get(name) ?? [])].sort()]),
  );
}

/** Every hostname a config value names: a URL anywhere, or a string under a host-like key. */
function configHosts(value: unknown, key: string, out: Set<string>, depth = 0): void {
  if (depth > 16) return;
  if (typeof value === 'string') {
    const host = hostOf(value);
    if (host !== undefined) out.add(host);
    else if (/^(?:host|hostname|domain|origin)s?$/i.test(key) && value.trim() !== '') {
      out.add(value.trim().toLowerCase());
    }
    return;
  }
  if (Array.isArray(value)) for (const entry of value) configHosts(entry, key, out, depth + 1);
  else if (isJsonObject(value)) {
    for (const [name, entry] of Object.entries(value)) configHosts(entry, name, out, depth + 1);
  }
}

/** Every `.env*` file's values at the app root, by name; two files holding one name keep both. */
async function dotenvValues(root: string): Promise<[string, string][]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob('.env*').scan({ cwd: root, dot: true })) files.push(path);
  const out: [string, string][] = [];
  for (const path of files.sort()) {
    out.push(...parseDotenv(await Bun.file(join(root, path)).text()));
  }
  return out;
}

export async function scrubSourcesOf(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ScrubSources> {
  const hosts = new Set<string>();
  configHosts(await appConfigExport(root, 'config'), '', hosts);
  const machine = hostname().toLowerCase();
  if (machine !== '') hosts.add(machine);
  const homes = [env['HOME'], env['USERPROFILE'], homedir()].filter(
    (home): home is string => typeof home === 'string' && home.length > 1,
  );
  return {
    root,
    homes,
    env: [...(await dotenvValues(root)), ...Object.entries(env)],
    hosts: [...hosts],
  };
}

/** `{ cause, stack }` beside the subject in a `--from` file (`data.error` or `error`), when there. */
export async function errorFromFile(path: string): Promise<ReproErrorFacts> {
  const parsed: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined);
  const data = isJsonObject(parsed) && isJsonObject(parsed['data']) ? parsed['data'] : parsed;
  const error = isJsonObject(data) ? data['error'] : undefined;
  if (!isJsonObject(error)) return { cause: null, stack: null };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return { cause: text(error['cause']), stack: text(error['stack']) };
}

/** The job row's last error and stack, or the error group's redacted sample for a request. */
export async function errorFromStore(
  driver: JobDriver,
  subject: ReproSubject,
): Promise<ReproErrorFacts> {
  if (subject.kind === 'job') {
    const trace = await inspectJob(driver, subject.failure.jobId);
    return { cause: trace?.lastError ?? null, stack: trace?.stack ?? null };
  }
  // A group store that cannot answer leaves the bundle without a stack, as `--list` leaves a count.
  const group = await postgresErrorGroupsStore()
    .get(subject.bundle.fingerprint)
    .catch(() => undefined);
  return { cause: group?.sample?.cause ?? null, stack: group?.sample?.stack ?? null };
}

/** The registries `loadApp` filled: what the redaction asks by name. */
export const registryLookups: ReproLookups = {
  inputSchema(kind, name) {
    if (kind === 'job') return getJob(name)?.input;
    return kind === 'action' ? getAction(name)?.input : getQuery(name)?.input;
  },
  entity(name) {
    const entry = getEntity(name);
    if (entry === undefined) return undefined;
    const sealed = entry.core === undefined ? [] : sealedFields(entry.core);
    return { description: entry.describe(), sealed: sealed.map((field) => field.property) };
  },
};
