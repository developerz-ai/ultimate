// `x upgrade` over an app whose TypeScript lags the scaffold's: every outcome names the manifest and
// the `bun add` that moves it, and the hop itself never touches the compiler range.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { fixture, recording, removeFixtures, run } from './cmd-upgrade-fixture';
import { TYPESCRIPT_VERSION } from './templates/scaffold-repo';

afterEach(removeFixtures);

/** The fixture's root manifest, a TypeScript major behind. */
const LAGGING = `${JSON.stringify(
  {
    name: 'app',
    workspaces: ['apps/*'],
    engines: { bun: '>=1.3.0' },
    dependencies: { '@ultimat3/cli': '^19.4.0', '@ultimat3/core': '^19.4.0' },
    devDependencies: { typescript: '^6.0.3' },
  },
  null,
  2,
)}\n`;

const FIX = `bun add -d 'typescript@${TYPESCRIPT_VERSION}'`;

describe('unit · x upgrade, a TypeScript below the scaffold`s', () => {
  test('--json carries the lag; the range is left for the author to move', async () => {
    const dir = await fixture({ 'package.json': LAGGING });
    const { output } = await run(dir, recording().runner);
    expect(output.data?.typescript).toEqual([
      {
        file: 'package.json',
        field: 'devDependencies',
        from: '^6.0.3',
        to: TYPESCRIPT_VERSION,
        fix: FIX,
      },
    ]);
    const manifest = await Bun.file(join(dir, 'package.json')).json();
    expect(manifest.devDependencies.typescript).toBe('^6.0.3');
  });

  test('the terminal names the command, on a dry run and at the target alike', async () => {
    const dir = await fixture({ 'package.json': LAGGING });
    const dry = (await run(dir, recording().runner, ['--dry-run'], { json: false })).lines;
    expect(dry.join('\n')).toContain(`typescript, by hand: package.json declares ^6.0.3`);
    expect(dry.join('\n')).toContain(`run: ${FIX}`);
    const at = await run(dir, recording({ versions: ['19.4.0'] }).runner, [], { json: false });
    expect(at.lines.join('\n')).toContain(`run: ${FIX}`);
    expect(at.lines.join('\n')).not.toContain('⟦');
  });

  test('an app on the scaffold`s TypeScript is told nothing', async () => {
    const dir = await fixture({ 'package.json': LAGGING.replace('^6.0.3', TYPESCRIPT_VERSION) });
    const { lines } = await run(dir, recording().runner, ['--dry-run'], { json: false });
    expect(lines.join('\n')).not.toContain('typescript, by hand');
    const { output } = await run(dir, recording().runner, ['--dry-run']);
    expect(output.data?.typescript).toEqual([]);
  });
});
