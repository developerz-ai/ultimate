// A boot warning said once per build id per role, not once per boot: a zero-byte marker on the
// disk the role's pods share remembers that some process of this build already said it. Fail
// open — a disk that refuses or stalls costs a duplicate line, never a lost one or a held boot.

import type { StorageDriver } from '@ultimat3/storage';

/** How long the marker may hold a boot: a warning never delays readiness past this. */
export const WARNED_MARKER_DEADLINE_MS = 2_000;
/** Markers kept per role, newest first: a rolling deploy's old build restarting stays quiet. */
export const WARNED_BUILDS_KEPT = 3;

export interface WarnOnceInput {
  /** Resolved inside the fail-open guard: a storage that cannot name its disk still warns. */
  readonly disk: () => StorageDriver;
  /** The app-and-environment scope (`retainedPrefix`), so staging never silences production. */
  readonly prefix: string;
  readonly role: string;
  readonly buildId: string;
  /** Test seam; `WARNED_MARKER_DEADLINE_MS` otherwise. */
  readonly deadlineMs?: number | undefined;
}

/** `<prefix>/warned/<role>/` — beside the retained files, outside `org/`, so never served. */
export const warnedPrefix = (prefix: string, role: string): string =>
  `${prefix}/warned/${encodeURIComponent(role)}/`;

const markerKey = (input: WarnOnceInput): string =>
  `${warnedPrefix(input.prefix, input.role)}${encodeURIComponent(input.buildId)}`;

async function prune(input: WarnOnceInput, disk: StorageDriver): Promise<void> {
  const own = markerKey(input);
  const page = await disk.list({ prefix: warnedPrefix(input.prefix, input.role) });
  // This build's marker is kept whatever the clock says (a disk's timestamps can tie); the rest
  // newest first. One with no `lastModified` has no age to rank by: spared, never guessed old.
  const others = page.rows.filter((row) => row.key !== own && row.lastModified !== undefined);
  const stale = others
    .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0))
    .slice(WARNED_BUILDS_KEPT - 1);
  for (const row of stale) await disk.delete(row.key);
}

/** `true` when this process should say it: no marker, or the disk could not answer. */
async function claim(input: WarnOnceInput): Promise<boolean> {
  // `async`, so a synchronous throw from `disk()` is a rejection the caller's guard catches.
  const key = markerKey(input);
  const disk = input.disk();
  if (await disk.exists(key)) return false;
  await disk.put(key, new Uint8Array(0), { contentType: 'application/octet-stream' });
  await prune(input, disk);
  return true;
}

/**
 * Calls `warn` unless a process of this build and role already did. Two pods booting in the same
 * instant may both say it — no shipped driver offers a create-if-absent put — which is the bound:
 * once per build per simultaneous boot, never once per boot.
 */
export async function warnOncePerBuild(input: WarnOnceInput, warn: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), input.deadlineMs ?? WARNED_MARKER_DEADLINE_MS);
  });
  // The marker is memory, not correctness: any failure of the disk says the warning instead.
  const said = await Promise.race([claim(input).catch(() => true), deadline]).finally(() =>
    clearTimeout(timer),
  );
  if (said !== false) warn();
}
