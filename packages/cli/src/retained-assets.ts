// Earlier builds' hashed files, kept readable across a deploy (`assets.retain`): a web pod
// publishes what it serves to a shared disk before it reports ready. This file is the publish and
// the key layout; the sweep is `retained-assets-sweep.ts`, the read `retained-assets-read.ts`.

import type { Clock } from '@ultimat3/core';
import {
  finiteCount,
  isUltimateError,
  logger,
  renderCauseValue,
  renderThrowable,
  systemClock,
  UltimateError,
} from '@ultimat3/core';
import type { BuildManifest, RetainedScope } from './retained-assets-layout';
import { inBatches, manifestKey, retainedFileKey } from './retained-assets-layout';
import { sweepRetained } from './retained-assets-sweep';

/**
 * How long a publish may hold the pod out of readiness. Past it the pod serves without having
 * published: a stalled bucket must not turn a deploy into one that never finishes.
 */
export const RETAIN_PUBLISH_DEADLINE_MS = 30_000;

/** One file a build serves, at the content-addressed URL its documents name. */
export interface BuildAsset {
  readonly url: string;
  readonly contentType: string;
  /** A `Blob` (`Bun.file`) for a file on disk: a disk refuses one past its ceiling unread. */
  readonly body: Uint8Array | Blob;
}

/** The two levels a publish speaks at; `logger` unless a test records them. */
export interface RetainLog {
  warn(message: string, fields: Readonly<Record<string, unknown>>): void;
  error(message: string, fields: Readonly<Record<string, unknown>>): void;
}

export interface PublishBuildAssetsInput extends RetainedScope {
  /** As `defineStorage` named it — in every log line, so the operator knows which bucket. */
  readonly diskName: string;
  readonly buildId: string;
  /** `assets.retain.builds`: how many builds' manifests, newest first, the sweep keeps. */
  readonly builds: number;
  readonly assets: readonly BuildAsset[];
  readonly clock?: Clock | undefined;
  readonly log?: RetainLog | undefined;
  /** Defaults to `RETAIN_PUBLISH_DEADLINE_MS`. */
  readonly deadlineMs?: number | undefined;
}

export interface PublishReport {
  /** `present`: another pod of this build published it; this one healed and re-dated it. */
  readonly outcome: 'published' | 'present' | 'failed';
  readonly put: number;
  /** URLs over the disk's put ceiling: served by their own build's pods only. */
  readonly skipped: readonly string[];
  /** Objects the sweep deleted. */
  readonly swept: number;
}

/** A put, list or delete the disk refused during a publish, or its deadline. Logged, not thrown. */
export class AssetRetainFailedError extends UltimateError {
  constructor(input: { readonly disk: string; readonly buildId: string; readonly error: unknown }) {
    super({
      code: 'X_ASSET_RETAIN_FAILED',
      cause: `publishing build ${renderCauseValue(input.buildId)} to the retained-asset disk ${renderCauseValue(input.disk)} failed (${renderThrowable(input.error)}) — this pod serves, but a tab holding an earlier build's document may meet a 404 for its stylesheet or island until it reloads`,
      fix: 'x doctor --json',
      meta: { disk: input.disk, buildId: input.buildId },
    });
  }
}

/** The deadline's own failure, named so the cause says which limit was hit. */
class PublishDeadlineError extends UltimateError {
  constructor(ms: number) {
    super({
      code: 'X_ASSET_RETAIN_FAILED',
      cause: `the publish did not finish within ${String(ms)}ms`,
      fix: 'x doctor --json',
    });
  }
}

const isTooLarge = (error: unknown): boolean =>
  isUltimateError(error) && error.code === 'X_STORAGE_TOO_LARGE';

/**
 * Never throws for the disk and never outlasts its deadline: a failure is one
 * `X_ASSET_RETAIN_FAILED` line and the pod serves, because a stale tab is a smaller harm than a
 * deploy that cannot start. A deadline that is not a whole number of at least 1 ms is refused up
 * front (`X_INVARIANT`): `setTimeout` fires a `NaN` at once. A publish
 * abandoned at the deadline may still finish in the background; every step of it is idempotent.
 */
export async function publishBuildAssets(input: PublishBuildAssetsInput): Promise<PublishReport> {
  const log = input.log ?? logger;
  const ms = finiteCount(
    'publishBuildAssets',
    'deadlineMs',
    input.deadlineMs ?? RETAIN_PUBLISH_DEADLINE_MS,
    1,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PublishDeadlineError(ms)), ms);
  });
  try {
    return await Promise.race([publish(input, log), deadline]);
  } catch (error) {
    const failed = new AssetRetainFailedError({
      disk: input.diskName,
      buildId: input.buildId,
      error,
    });
    log.error(failed.code, {
      code: failed.code,
      cause: failed.cause,
      fix: failed.fix,
      disk: input.diskName,
      buildId: input.buildId,
    });
    return { outcome: 'failed', put: 0, skipped: [], swept: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The same steps whether or not the build was published before: put each missing file, write the
 * manifest dated NOW, put back anything a sweep took meanwhile. So a build whose files a bad sweep
 * removed heals on its next pod, and a rolled-back build — the one live — is the newest manifest.
 */
async function publish(input: PublishBuildAssetsInput, log: RetainLog): Promise<PublishReport> {
  const { disk, prefix, buildId } = input;
  const present = await disk.exists(manifestKey(prefix, buildId));
  const skipped: string[] = [];
  let put = 0;
  const ensure = async (asset: BuildAsset): Promise<void> => {
    const key = retainedFileKey(prefix, asset.url);
    if (await disk.exists(key)) return;
    try {
      await disk.put(key, asset.body, { contentType: asset.contentType });
      put += 1;
    } catch (error) {
      if (!isTooLarge(error)) throw error;
      if (!skipped.includes(asset.url)) skipped.push(asset.url);
    }
  };
  await inBatches(input.assets, ensure);
  if (skipped.length > 0) {
    log.warn('assets.retain_skipped', {
      disk: input.diskName,
      buildId,
      urls: [...skipped].sort(),
      cause: "over the disk's maxPutBytes, so only this build's own pods serve them",
      fix: 's3Driver({ bucket, maxPutBytes: <bytes> })   # the disk assets.retain.disk names, in its defineStorage; localDriver takes the same option',
    });
  }
  const kept = input.assets.filter((asset) => !skipped.includes(asset.url));
  const now = (input.clock ?? systemClock).now().getTime();
  const manifest: BuildManifest = { buildId, publishedAt: now, urls: kept.map((a) => a.url) };
  await disk.put(manifestKey(prefix, buildId), new TextEncoder().encode(JSON.stringify(manifest)), {
    contentType: 'application/json',
  });
  // A sweep on another pod may have read the manifests before this one existed and deleted a file
  // this build found present: asked again now that the manifest protects it from the next sweep.
  await inBatches(kept, ensure);
  if (present) return { outcome: 'present', put, skipped: [...skipped].sort(), swept: 0 };
  const swept = await sweepRetained({ disk, prefix }, input.builds, now);
  return { outcome: 'published', put, skipped: [...skipped].sort(), swept };
}
