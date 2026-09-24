// What a container loads, as a build error. `@ultimat3/cli/serve` is the one import an app's
// `apps/web/server.ts` makes, and its module graph must carry nothing that exists for development
// or tests: `@ultimat3/testing` (38 modules rode in through the live replicator until it moved to
// `@ultimat3/realtime/server`), the CLI's scaffold templates, the e2e driver, the CDP browser.
// The barrel it replaced was 1,349 modules.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the metafile needs a scratch directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; the child's argv takes paths already joined.
import { join } from 'node:path';

/** Never a production module: a harness, a generator's text, a browser driver. */
const FORBIDDEN = /packages\/testing\/|packages\/cli\/src\/templates\/|\/e2e-|\/cdp-/;

/**
 * measured: 1033 modules (`Bun.build` metafile, 2026-09-23, 259 of them external packages under
 * node_modules). why: the ceiling is that plus 10%, so a real feature on the boot path fits and a
 * whole subsystem arriving does not. Raise it with the new measured number in the same diff.
 */
const MODULE_CEILING = 1136;

describe('the @ultimat3/cli/serve module graph', () => {
  test('carries no test, template, e2e or cdp module, under its pinned size', async () => {
    // A child `bun build`, never `Bun.build` in this process: the test preload installs plugins
    // that change what resolves, and the graph under test is the one a plain build sees.
    const dir = mkdtempSync(join(tmpdir(), 'serve-graph-'));
    const meta = join(dir, 'meta.json');
    const child = Bun.spawnSync(
      [
        process.execPath,
        'build',
        join(import.meta.dir, 'serve-entry.ts'),
        '--target=bun',
        `--outdir=${join(dir, 'out')}`,
        `--metafile=${meta}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect([child.exitCode, child.stderr.toString().slice(0, 400)]).toEqual([0, '']);
    const inputs = Object.keys(
      ((await Bun.file(meta).json()) as { inputs: Record<string, unknown> }).inputs,
    );
    rmSync(dir, { recursive: true, force: true });
    // Non-vacuity: a build that answered no metafile would pass every assertion below.
    expect(inputs.length).toBeGreaterThan(100);
    expect(inputs.filter((path) => FORBIDDEN.test(path))).toEqual([]);
    expect(inputs.length).toBeLessThanOrEqual(MODULE_CEILING);
  }, 60_000);
});
