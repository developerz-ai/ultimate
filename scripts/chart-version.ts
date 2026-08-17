#!/usr/bin/env bun
// Enforce, as a gate step, that `docker/helm/Chart.yaml` still carries the lockstep version — and
// give `scripts/release.ts` the one function that keeps it there, so it stops being hand-kept.
//
// `appVersion` is NOT metadata: `values.yaml` ships `image.tag: ""`, which the chart defaults to
// `.Chart.AppVersion`, so the chart's number IS the image tag a fresh `helm install` pulls. It sat
// at `0.0.1` — a tag no release has ever pushed — through every 1.x release, and the reason is
// structural: `scripts/release.ts` rewrites WORKSPACE manifests, and a chart is not a workspace.
// Bumping it by hand fixes today and drifts again on the next release.
//
// Runs on `x verify`'s `manifest` step: "does a committed file still describe the code?" is that
// step's own question, and this is the same question `frameworkManifest` asks about the manifest.
//
//   bun run scripts/chart-version.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces, publishOrder } from './lib/workspaces';

export const CHART_FILE = 'docker/helm/Chart.yaml';

/** The two keys that must move together. `version` is the chart's, `appVersion` is the image tag. */
export const CHART_VERSION_KEYS = ['version', 'appVersion'] as const;

export type ChartVersionKey = (typeof CHART_VERSION_KEYS)[number];

export interface ChartGap {
  readonly key: ChartVersionKey;
  /** Absent when the chart carries no such key at all. */
  readonly found?: string;
  readonly expected: string;
}

export interface ChartVersionInput {
  /** `docker/helm/Chart.yaml`, verbatim. */
  readonly chart: string;
  /** The version every publishable workspace is stamped at. */
  readonly version: string;
}

/**
 * One top-level scalar, read without a YAML parser — the file is eight flat keys and pulling in a
 * parser for it would be a dependency the build-vs-wrap criterion refuses. Anchored at column 0, so
 * `apiVersion:` and `kubeVersion:` cannot answer for `version:`; quotes and a trailing comment come
 * off, because `appVersion: "1.2.0"` and `version: 1.2.0` are the same fact spelled two ways.
 */
export function readChartScalar(chart: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(chart);
  if (match === null) return undefined;
  const raw = (match[1] ?? '').replace(/\s+#.*$/, '').trim();
  return raw.replace(/^["']|["']$/g, '');
}

/** Pure, so the negative case is a fixture rather than an edit to the chart a release ships. */
export function checkChartVersion(input: ChartVersionInput): readonly ChartGap[] {
  const gaps: ChartGap[] = [];
  for (const key of CHART_VERSION_KEYS) {
    const found = readChartScalar(input.chart, key);
    if (found === input.version) continue;
    gaps.push({ key, expected: input.version, ...(found === undefined ? {} : { found }) });
  }
  return gaps;
}

/**
 * The rewrite half, and the reason this file exists rather than a lone assertion: `release.ts`
 * calls it in the same pass that rewrites the workspace manifests, so the chart moves with the
 * lockstep version instead of being remembered. `appVersion` keeps its quotes — a bare `1.2.0` is
 * a YAML float in enough parsers to be worth not finding out.
 */
export function setChartVersions(raw: string, version: string): string {
  // An ABSENT key is the case a `.replace()` pair silently does nothing for, and `release.ts` then
  // prints `chart … -> 1.3.0` over a chart that received neither key — a report of work that did
  // not happen, which is this slice's whole subject. A missing `appVersion` is worse than a stale
  // one: `values.yaml` ships `image.tag: ""`, so the tag resolves to empty and helm installs
  // `ultimate-app:`. Written rather than repaired-later, so the output always satisfies
  // `checkChartVersion` — that property is what `chart-version.test.ts` asserts.
  const write = (text: string, key: ChartVersionKey, value: string): string => {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${key}:[^\\n]*`, 'm');
    if (pattern.test(text)) return text.replace(pattern, line);
    return `${text.replace(/\n*$/, '')}\n${line}\n`;
  };
  return write(write(raw, 'version', version), 'appVersion', `"${version}"`);
}

const staleFinding = (gap: ChartGap): Finding => ({
  code: 'X_CHART_VERSION_STALE',
  cause:
    gap.found === undefined
      ? `${CHART_FILE} has no ${gap.key}, and appVersion is the default image tag (values.yaml ships image.tag: "") — a chart with no version is one helm cannot install`
      : `${CHART_FILE} says ${gap.key} ${gap.found} and every publishable workspace is stamped at ${gap.expected}; appVersion is the default image tag (values.yaml ships image.tag: ""), so helm install pulls a tag no release pushed`,
  fix: `set ${gap.key}: ${gap.key === 'appVersion' ? `"${gap.expected}"` : gap.expected} in ${CHART_FILE}, then bun run scripts/chart-version.ts --json — a release does this for you (scripts/release.ts)`,
  at: CHART_FILE,
});

export const chartGapFindingFor = (gap: ChartGap): Finding => staleFinding(gap);

/**
 * The lockstep version, or nothing. Nothing when the publishable workspaces DISAGREE: that is
 * `X_RELEASE_VERSION_SKEW`'s finding and `package-shape`'s, and reporting it here as a chart
 * problem would be a second name for one fact — and would name the wrong file to edit.
 */
export async function lockstepVersion(root: string): Promise<string | undefined> {
  const publishable = publishOrder(await listWorkspaces(root));
  const versions = new Set(publishable.map((workspace) => workspace.version));
  return versions.size === 1 ? [...versions][0] : undefined;
}

/**
 * Read the chart and the workspaces, then check them. The one impure step. A root with no chart is
 * not this check's problem — the host checks run against synthetic trees in `scripts/verify.test.ts`.
 */
export async function chartVersionGaps(root: string): Promise<readonly ChartGap[]> {
  const file = Bun.file(`${root}/${CHART_FILE}`);
  if (!(await file.exists())) return [];
  const version = await lockstepVersion(root);
  if (version === undefined) return [];
  return checkChartVersion({ chart: await file.text(), version });
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export const chartVersionFindings = async (root: string): Promise<readonly Finding[]> =>
  (await chartVersionGaps(root)).map(chartGapFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const version = await lockstepVersion(root);
  const gaps = await chartVersionGaps(root);
  report(
    {
      ok: gaps.length === 0,
      script: 'chart-version',
      summary:
        gaps.length === 0
          ? `${CHART_FILE} tracks the lockstep version (${version ?? 'not decidable — the workspaces disagree'})`
          : `${gaps.length} of ${CHART_VERSION_KEYS.length} chart version key(s) behind the lockstep version`,
      findings: gaps.map(chartGapFindingFor),
      data: { version: version ?? null },
    },
    args.json,
  );
}
