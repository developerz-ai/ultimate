// The gate rule that keeps `docker/helm/Chart.yaml` on the lockstep version, and the rewrite
// `scripts/release.ts` performs so it stays there. Every negative case is a FIXTURE — never an edit
// to the real chart, which is the file a `helm install` resolves its image tag from.

import { describe, expect, test } from 'bun:test';
// why: `node:` — Bun has no temporary-directory or path-join primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  CHART_FILE,
  chartGapFindingFor,
  chartVersionGaps,
  checkChartVersion,
  lockstepVersion,
  readChartScalar,
  setChartVersions,
} from './chart-version';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const chart = (version: string, appVersion: string): string =>
  [
    'apiVersion: v2',
    'name: ultimate',
    `version: ${version}`,
    `appVersion: "${appVersion}"`,
    'kubeVersion: ">=1.27.0-0"',
    '',
  ].join('\n');

const findings = (raw: string, version = '1.3.0') =>
  checkChartVersion({ chart: raw, version }).map(chartGapFindingFor);

describe('unit · a chart left behind by a release', () => {
  test('is refused on both keys, and the cause says what a helm install would pull', () => {
    const found = findings(chart('1.2.0', '1.2.0'));

    expect(found).toHaveLength(2);
    expect(found[0]?.code).toBe('X_CHART_VERSION_STALE');
    expect(found[0]?.cause).toContain('1.2.0');
    expect(found[0]?.cause).toContain('1.3.0');
    // The whole point: appVersion IS the image tag, so this is a pull failure, not a doc nit.
    expect(found[1]?.cause).toContain('default image tag');
    expect(found[1]?.fix).toContain('appVersion: "1.3.0"');
    expect(found[0]?.at).toBe(CHART_FILE);
  });

  test('passes when both keys are the lockstep version', () => {
    expect(findings(chart('1.3.0', '1.3.0'))).toEqual([]);
  });

  test('one key moved and the other forgotten is still a finding', () => {
    const found = findings(chart('1.3.0', '1.2.0'));
    expect(found).toHaveLength(1);
    expect(found[0]?.cause).toContain('appVersion');
  });

  test('a chart with no version key at all is a finding, not a pass', () => {
    const found = findings('apiVersion: v2\nname: ultimate\n');
    expect(found).toHaveLength(2);
    expect(found[0]?.cause).toContain('has no version');
  });
});

describe('unit · reading the chart without a YAML parser', () => {
  test('`apiVersion` and `kubeVersion` cannot answer for `version`', () => {
    // The anchor that makes the whole thing safe: without `^`, `apiVersion: v2` is the first match
    // and every chart reads as version "v2".
    expect(readChartScalar(chart('1.3.0', '1.3.0'), 'version')).toBe('1.3.0');
    expect(readChartScalar('apiVersion: v2\n', 'version')).toBeUndefined();
  });

  test('quotes and a trailing comment are not part of the version', () => {
    expect(readChartScalar('appVersion: "1.3.0"  # the image tag\n', 'appVersion')).toBe('1.3.0');
    expect(readChartScalar("version: '1.3.0'\n", 'version')).toBe('1.3.0');
  });
});

describe('unit · the rewrite a release performs', () => {
  test('moves both keys and leaves every other line alone', () => {
    const next = setChartVersions(chart('1.2.0', '1.2.0'), '1.3.0');

    expect(next).toContain('version: 1.3.0');
    // Quoted, because a bare 1.3.0 is a YAML float to enough parsers to be worth not finding out.
    expect(next).toContain('appVersion: "1.3.0"');
    expect(next).toContain('apiVersion: v2');
    expect(next).toContain('kubeVersion: ">=1.27.0-0"');
    // And the result satisfies the rule, which is the property that makes the release self-consistent.
    expect(findings(next, '1.3.0')).toEqual([]);
  });

  test('is idempotent — a second release pass over an already-moved chart changes nothing', () => {
    const once = setChartVersions(chart('1.2.0', '1.2.0'), '1.3.0');
    expect(setChartVersions(once, '1.3.0')).toBe(once);
  });

  /**
   * The property, stated once and asserted over every shape: whatever went in, what comes out
   * satisfies the rule. An absent key made both replacements silent no-ops, so `release.ts` printed
   * `chart … -> 1.3.0` over a chart that received nothing — and a missing `appVersion` resolves the
   * default image tag to empty, so `helm install` pulls `ultimate-app:`.
   */
  test.each([
    ['both keys present', chart('1.2.0', '1.2.0')],
    ['no appVersion', 'apiVersion: v2\nname: ultimate\nversion: 1.2.0\n'],
    ['no version', 'apiVersion: v2\nname: ultimate\nappVersion: "1.2.0"\n'],
    ['neither key', 'apiVersion: v2\nname: ultimate\n'],
    ['no trailing newline', 'apiVersion: v2'],
  ])('writes what is missing: %s', (_name, input) => {
    const next = setChartVersions(input, '1.3.0');

    expect(findings(next, '1.3.0')).toEqual([]);
    expect(readChartScalar(next, 'version')).toBe('1.3.0');
    expect(readChartScalar(next, 'appVersion')).toBe('1.3.0');
    // Appending must not eat the chart it was given.
    expect(next).toContain('apiVersion: v2');
    expect(next.endsWith('\n')).toBe(true);
  });
});

describe('unit · this repo', () => {
  test(
    'the shipped chart carries the version every publishable workspace is stamped at',
    async () => {
      const root = repoRoot();
      expect(await lockstepVersion(root)).toMatch(/^\d+\.\d+\.\d+/);
      expect(await chartVersionGaps(root)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('a tree whose workspaces disagree yields no chart finding — that is the release rule’s', async () => {
    // Guards the one way this check could name the wrong file: skew is X_RELEASE_VERSION_SKEW's
    // finding, and reporting it here would send an author to edit the chart instead of the package.
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-chart-skew-'));
    try {
      await Bun.write(join(dir, 'packages/core/package.json'), '{"name":"a","version":"1.2.0"}\n');
      await Bun.write(
        join(dir, 'packages/schema/package.json'),
        '{"name":"b","version":"1.3.0"}\n',
      );
      await Bun.write(join(dir, CHART_FILE), chart('9.9.9', '9.9.9'));

      expect(await lockstepVersion(dir)).toBeUndefined();
      expect(await chartVersionGaps(dir)).toEqual([]);

      // …and the moment they agree, the same chart is reported. Without this half the assertion
      // above would pass for a tree where the rule was simply switched off.
      await Bun.write(
        join(dir, 'packages/schema/package.json'),
        '{"name":"b","version":"1.2.0"}\n',
      );
      expect(await lockstepVersion(dir)).toBe('1.2.0');
      expect(await chartVersionGaps(dir)).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
