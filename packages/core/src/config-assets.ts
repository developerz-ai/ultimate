// Single responsibility: the `assets` block of `app.config.ts` — whether a web pod keeps earlier
// builds' hashed files reachable across a deploy, and on which disk. Its own file for the reason
// `config-mail.ts` is: shape, merge and screen are one subject, and `config.ts` is at its ceiling.

import { countIssue } from './config-count';
import { describeValue } from './error-render';
import { isJsonObject } from './json-object';

/**
 * A retention window over a disk the web role can read: an S3-compatible bucket, or a volume every
 * replica mounts. `builds` has NO default — how many deploys an open tab may survive is the app's
 * decision (axiom 8), and a guessed number is either a bucket that grows or a tab that breaks.
 */
export interface AssetsRetainConfig {
  /** A disk name from the app's `defineStorage({ disks })`, checked against it at boot. */
  readonly disk: string;
  /** How many builds' files stay readable, newest first: a whole number of at least 1. */
  readonly builds: number;
}

/** `retain` absent is today's behaviour: each process serves only the assets it built. */
export interface AssetsConfig {
  readonly retain: AssetsRetainConfig | undefined;
}

export interface AssetsSection {
  readonly assets: AssetsConfig;
}

export interface AssetsSectionInput {
  readonly assets?: { readonly retain?: AssetsRetainConfig | undefined } | undefined;
}

/** The last layer that said it wins, as every scalar does; a wrong shape is carried AS WRITTEN. */
export function mergeAssets(layers: readonly AssetsSectionInput[]): AssetsSection {
  let retain: AssetsConfig['retain'];
  for (const layer of layers) {
    const said = layer.assets?.retain;
    if (said !== undefined) retain = said;
  }
  return { assets: { retain } };
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function assetsIssues(
  config: { readonly assets?: AssetsConfig | undefined },
  issues: string[],
): void {
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const retain: unknown = config.assets?.retain;
  if (retain === undefined) return;
  if (!isJsonObject(retain)) {
    issues.push(`assets.retain must be { disk, builds }, not ${describeValue(retain)}`);
    return;
  }
  const disk: unknown = retain['disk'];
  if (typeof disk !== 'string' || disk.trim() === '') {
    issues.push(
      `assets.retain.disk must name a disk declared with defineStorage, not ${describeValue(disk)}`,
    );
  }
  const builds = countIssue('assets.retain.builds', retain['builds'], 1);
  if (builds !== undefined) issues.push(builds);
}
