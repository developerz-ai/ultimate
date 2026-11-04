// The `assets.retain` sweep: keep the newest `builds` manifests of one app-and-environment scope
// and delete the files none of them names — without ever deleting what another pod is publishing
// at the same moment. Run at the end of a publish.

import type { RetainedScope, StoredManifest } from './retained-assets-layout';
import {
  filesPrefix,
  inBatches,
  listAll,
  readManifests,
  retainedFileKey,
} from './retained-assets-layout';

/**
 * A file put this recently is spared whatever the manifests say: it may belong to a publish still
 * in flight on another pod, whose manifest is not written yet. Far longer than a publish may take
 * (`RETAIN_PUBLISH_DEADLINE_MS`), so clock skew between a pod and the disk does not eat it.
 */
export const RETAIN_SWEEP_GRACE_MS = 10 * 60_000;

const urlsOf = (manifests: readonly StoredManifest[]): readonly string[] =>
  manifests.flatMap(({ manifest }) => manifest.urls);

/**
 * Manifests, then files, then the dropped manifests: a pod killed anywhere leaves extra objects,
 * never a missing one. Three guards against a concurrent publish: a file younger than the grace
 * stays; the manifests are read AGAIN just before deleting, and any that appeared keeps what it
 * names; a manifest that does not parse stops the sweep. Returns the files deleted.
 */
export async function sweepRetained(
  scope: RetainedScope,
  builds: number,
  startedAt: number,
): Promise<number> {
  const manifests = await readManifests(scope);
  if (manifests === undefined) return 0;
  const ordered = [...manifests].sort(
    (a, b) =>
      b.manifest.publishedAt - a.manifest.publishedAt ||
      a.manifest.buildId.localeCompare(b.manifest.buildId),
  );
  const dropped = ordered.slice(builds);
  if (dropped.length === 0) return 0;
  const droppedAt = new Map(dropped.map(({ key, manifest }) => [key, manifest.publishedAt]));
  const files = await listAll(scope.disk, filesPrefix(scope.prefix));
  const again = await readManifests(scope);
  if (again === undefined) return 0;
  // Still dropped: read the first time as dropped and not re-dated since by a pod of that build
  // booting again (a rollback), which makes it the newest and not ours to drop.
  const stillDropped = (one: StoredManifest): boolean =>
    droppedAt.get(one.key) === one.manifest.publishedAt;
  const named = new Set(
    urlsOf(again.filter((one) => !stillDropped(one))).map((url) =>
      retainedFileKey(scope.prefix, url),
    ),
  );
  const redated = new Set(
    again.filter((one) => droppedAt.has(one.key) && !stillDropped(one)).map(({ key }) => key),
  );
  const cutoff = startedAt - RETAIN_SWEEP_GRACE_MS;
  const doomed = files
    .filter((entry) => !named.has(entry.key))
    // Unknown age is spared, as `sweepOrphans` spares it: never epoch 0, never "old enough".
    .filter((entry) => entry.lastModified !== undefined && entry.lastModified.getTime() < cutoff)
    .map((entry) => entry.key);
  await inBatches(doomed, (key) => scope.disk.delete(key));
  const drop = dropped.filter(({ key }) => !redated.has(key));
  await inBatches(drop, ({ key }) => scope.disk.delete(key));
  return doomed.length;
}
