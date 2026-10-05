// The file-size WARNING band: a file within reach of the ceiling is listed, never failed — so a
// split is planned at 450 lines instead of a file being trimmed to fit at 500.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import type { Runner } from './exec';
import { VERIFY_STEPS } from './verify-checks';
import { checkFileSizes, fileSizeReport, LINE_CEILING, WARN_BAND } from './workspace-checks';

const lines = (count: number): string =>
  `${Array.from({ length: count }, () => 'const x = 1;').join('\n')}\n`;

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-size-band-'));
  await Bun.write(join(dir, 'packages/p/src/under.ts'), lines(WARN_BAND - 1));
  await Bun.write(join(dir, 'packages/p/src/at-band.ts'), lines(WARN_BAND));
  await Bun.write(join(dir, 'packages/p/src/near.ts'), lines(LINE_CEILING));
  await Bun.write(join(dir, 'packages/p/src/over.ts'), lines(LINE_CEILING + 1));
  await Bun.write(join(dir, 'packages/p/src/stale.d.ts'), lines(LINE_CEILING - 1));
  const reExports = `${Array.from(
    { length: WARN_BAND + 10 },
    (_unused, index) => `export { name${index} } from './name${index}';`,
  ).join('\n')}\n`;
  await Bun.write(join(dir, 'packages/p/src/index.ts'), reExports);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('unit · the file-size warning band', () => {
  test('the band sits below the ceiling', () => {
    expect(WARN_BAND).toBe(450);
    expect(WARN_BAND).toBeLessThan(LINE_CEILING);
  });

  test('a file from the band up to the ceiling is a warning, not a finding', async () => {
    const report = await fileSizeReport(dir);
    expect(report.warnings).toEqual([
      { path: 'packages/p/src/at-band.ts', lines: WARN_BAND, ceiling: LINE_CEILING },
      { path: 'packages/p/src/near.ts', lines: LINE_CEILING, ceiling: LINE_CEILING },
    ]);
    expect(report.findings.map((finding) => finding.at)).toEqual(['packages/p/src/over.ts']);
  });

  // The band is advice about the ceiling, so it exempts exactly what the ceiling exempts.
  test('an exempt re-export manifest and an emitted declaration are not warned about', async () => {
    const warned = (await fileSizeReport(dir)).warnings.map((warning) => warning.path);
    expect(warned).not.toContain('packages/p/src/index.ts');
    expect(warned).not.toContain('packages/p/src/stale.d.ts');
  });

  test('checkFileSizes is still the findings alone: a warning never fails the step', async () => {
    expect(await checkFileSizes(dir)).toEqual((await fileSizeReport(dir)).findings);
  });
});

describe('integration · the filesize step', () => {
  test('lists the band as warnings, red only for what is over the ceiling', async () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'filesize');
    // The step reads files and spawns nothing, so a runner that is never called is the honest one.
    const runner: Runner = async (command) => ({
      command,
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    });
    const outcome = await step?.run({ root: dir, runner });
    expect(outcome?.ok).toBe(false);
    expect(outcome?.findings.map((finding) => finding.at)).toEqual(['packages/p/src/over.ts']);
    expect(outcome?.warnings).toEqual([
      `packages/p/src/at-band.ts: ${WARN_BAND} lines, ${LINE_CEILING - WARN_BAND} under the ${LINE_CEILING} line ceiling — plan the split`,
      `packages/p/src/near.ts: ${LINE_CEILING} lines, 0 under the ${LINE_CEILING} line ceiling — plan the split`,
    ]);
  });
});
