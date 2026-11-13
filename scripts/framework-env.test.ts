// The enforcement half of `scripts/framework-env.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a literal env read in shipped source that
// `FRAMEWORK_ENV` does not list fails `bun run verify` with no extra wiring.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { maskLiterals, stripComments } from '../packages/core/src/source-mask';
import type { SourceFile } from './framework-env';
import { envReads, frameworkEnvCheck, frameworkEnvFindings, REGISTRY_FILE } from './framework-env';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms default.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const file = (path: string, source: string): SourceFile => ({
  path,
  masked: maskLiterals(source),
  stripped: stripComments(source),
});

const names = (source: string): readonly string[] =>
  envReads('packages/x/src/a.ts', maskLiterals(source), stripComments(source)).map(
    (read) => `${read.name}${read.prefix ? '*' : ''}`,
  );

/** The registry's own file, so the stale check has every registered name spelled somewhere. */
const registry = async (): Promise<SourceFile> =>
  file(REGISTRY_FILE, await Bun.file(`${repoRoot()}/${REGISTRY_FILE}`).text());

describe('what counts as a read', () => {
  test('every receiver spelling, by index and by property', () => {
    expect(names("process.env['A_B']; Bun.env.C_D; ctx.env[\"E\"]; env?.['F'];")).toEqual([
      'A_B',
      'C_D',
      'E',
      'F',
    ]);
  });

  test('a template key is its static head, read as a prefix', () => {
    expect(names(`env[\`OTEL_\${signal}_EXPORTER\`];`)).toEqual(['OTEL_*']);
    expect(names('env[`PLAIN`];')).toEqual(['PLAIN']);
  });

  test('a read quoted in a fix string or a comment is not a read', () => {
    expect(names("const fix = 'Number(process.env.TTL_MS) is NaN';\n// process.env.DELAY")).toEqual(
      [],
    );
  });

  test('a computed key is not a literal read, and `environment.X` is not `env`', () => {
    expect(names('env[key]; environment.PORT;')).toEqual([]);
  });
});

describe('the registry', () => {
  test('an unregistered literal read is red, named at its line', async () => {
    const findings = frameworkEnvFindings([
      await registry(),
      file('packages/x/src/a.ts', "\nconst v = process.env['NOT_A_FRAMEWORK_NAME'];"),
    ]).filter((finding) => finding.code === 'X_FRAMEWORK_ENV_UNREGISTERED');
    expect(findings.map((finding) => finding.at)).toEqual(['packages/x/src/a.ts:2']);
    expect(findings[0]?.fix).toContain(REGISTRY_FILE);
  });

  test('a registered name, and a name under a registered prefix, are not', async () => {
    const findings = frameworkEnvFindings([
      await registry(),
      file(
        'packages/x/src/a.ts',
        `env['DATABASE_URL']; env['ULTIMATE_ANYTHING']; env[\`OTEL_\${s}\`];`,
      ),
    ]).filter((finding) => finding.code === 'X_FRAMEWORK_ENV_UNREGISTERED');
    expect(findings).toEqual([]);
  });

  test('a template head under no registered prefix is red even when it is a registered name', async () => {
    const findings = frameworkEnvFindings([
      await registry(),
      file('packages/x/src/a.ts', `env[\`PORT\${suffix}\`];`),
    ]).filter((finding) => finding.code === 'X_FRAMEWORK_ENV_UNREGISTERED');
    expect(findings).toHaveLength(1);
  });

  test('a fixture is not shipped source', async () => {
    const findings = frameworkEnvFindings([
      await registry(),
      file('packages/x/src/a-fixture.ts', "process.env['NOT_A_FRAMEWORK_NAME'];"),
    ]).filter((finding) => finding.code === 'X_FRAMEWORK_ENV_UNREGISTERED');
    expect(findings).toEqual([]);
  });

  test('a listed name no shipped file spells is stale', async () => {
    // Only the registry itself: every name it lists is spelled nowhere else.
    const stale = frameworkEnvFindings([await registry()]).filter(
      (finding) => finding.code === 'X_FRAMEWORK_ENV_STALE',
    );
    expect(stale.length).toBeGreaterThan(50);
    expect(stale.some((finding) => finding.cause.includes('CLOUDFLARE_API_TOKEN'))).toBe(true);
  });
});

describe('the real tree', () => {
  test('every literal env read in shipped source is listed, and nothing listed is stale', async () => {
    const result = await frameworkEnvCheck(repoRoot());
    expect(result.findings).toEqual([]);
  });
});
