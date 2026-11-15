// `x upgrade` and its codemods: the hop asks the CLI it installed (`x upgrade codemods`) before any
// gate stage, reports `data.codemods` and a line per codemod; an installed CLI with no engine
// leaves it to this one; a dry run previews and writes nothing. Superseded workarounds are warnings.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  codemodsDocument,
  fixture,
  git,
  recording,
  removeFixtures,
  run,
} from './cmd-upgrade-fixture';
import type { ExecResult, Runner } from './exec';
import { names } from './templates';
import { claudeFiles } from './templates/scaffold-claude';

afterEach(removeFixtures);

const SETTINGS = '.claude/settings.json';
const HOOK = '.claude/hooks/format-edited.ts';

/** `.claude/settings.json` as `x new` wrote it before 31.22.0: the hook that formatted nothing. */
const oldSettings = (): string =>
  String(claudeFiles(names('app')).find((file) => file.path === SETTINGS)?.contents ?? '').replace(
    [
      '        "matcher": "Edit|Write|MultiEdit",',
      '        "hooks": [',
      '          {',
      '            "type": "command",',
      '            "command": "bun \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/format-edited.ts",',
      '            "timeout": 20',
    ].join('\n'),
    [
      '        "matcher": "Edit|Write",',
      '        "hooks": [',
      '          {',
      '            "type": "command",',
      '            "command": "bunx biome check --no-errors-on-unmatched --write \\"$CLAUDE_FILE_PATHS\\" 2>/dev/null || true"',
    ].join('\n'),
  );

/** An app pinned at 31.19.0 with the old hook, and a registry that publishes 31.22.0. */
const pinned = async (
  extra: Readonly<Record<string, string>> = {},
  version = '31.19.0',
): Promise<string> =>
  fixture({
    'package.json': `${JSON.stringify(
      {
        name: 'app',
        workspaces: ['apps/*'],
        engines: { bun: '>=1.3.0' },
        dependencies: { '@ultimat3/cli': `^${version}`, '@ultimat3/core': `^${version}` },
      },
      null,
      2,
    )}\n`,
    'apps/web/package.json': `${JSON.stringify({ name: 'web' }, null, 2)}\n`,
    [SETTINGS]: oldSettings(),
    ...extra,
  });

const VERSIONS = ['31.19.0', '31.22.0'];

/** The recording runner, plus every argv the installed CLI's `upgrade` was given. */
const withCodemods = (script: Parameters<typeof recording>[0] = {}) => {
  const recorded = recording({ versions: VERSIONS, ...script });
  const asked: (readonly string[])[] = [];
  const runner: Runner = async (command, options): Promise<ExecResult> => {
    if (command[1]?.endsWith('bin.ts') && command[2] === 'upgrade') asked.push(command.slice(2));
    return recorded.runner(command, options);
  };
  return { ...recorded, runner, asked };
};

const read = (dir: string, path: string): Promise<string> => Bun.file(join(dir, path)).text();

describe('unit · x upgrade, codemods', () => {
  test('the hop asks the installed CLI for the span, before the manifest, and reports its answer', async () => {
    const dir = await pinned();
    const applied = [
      {
        id: 'format-edited-hook',
        since: '31.22.0',
        summary: 'the hook runs',
        changed: [SETTINGS],
        skipped: [{ path: '.claude/README.md', reason: 'the app edited it', diff: '+new line\n' }],
      },
    ];
    const { runner, spawned, asked } = withCodemods({
      codemods: codemodsDocument(applied, { from: '31.19.0', to: '31.22.0' }),
    });
    const { code, output, lines } = await run(dir, runner);
    expect(code).toBe(0);
    expect(asked).toEqual([
      ['upgrade', 'codemods', '--from', '31.19.0', '--to', '31.22.0', '--json'],
    ]);
    expect(spawned.indexOf('x upgrade')).toBe(spawned.indexOf('x manifest') - 1);
    expect(output.data?.codemods).toEqual({
      from: '31.19.0',
      to: '31.22.0',
      dryRun: false,
      applied,
      source: 'installed',
    });
    const human = (
      await run(await pinned(), withCodemods({ codemods: codemodsDocument(applied) }).runner, [], {
        json: false,
      })
    ).lines.join('\n');
    expect(human).toContain('codemod format-edited-hook (31.22.0): 1 changed, 1 left for you');
    expect(human).toContain('left for you: .claude/README.md — the app edited it');
    expect(human).toContain('    +new line');
    expect(lines.join('\n')).not.toContain('⟦');
  });

  test('an installed CLI with no codemods subcommand leaves the span to this CLI, which applies it', async () => {
    const dir = await pinned();
    const { runner } = withCodemods({
      codemods: '{"ok":false,"findings":[{"code":"X_CLI_UNKNOWN_COMMAND"}]}',
      codemodsCode: 1,
    });
    const { output } = await run(dir, runner);
    const codemods = output.data?.codemods as {
      readonly source: string;
      readonly applied: readonly { readonly id: string; readonly changed: readonly string[] }[];
    };
    expect(codemods.source).toBe('driver');
    expect(codemods.applied.map((one) => one.id)).toEqual([
      'authenticator-session-refusal',
      'format-edited-hook',
    ]);
    expect(await read(dir, SETTINGS)).toContain(HOOK);
    expect(await Bun.file(join(dir, HOOK)).exists()).toBe(true);
    // Left uncommitted beside the pins: the hop is still one reviewable commit.
    expect(await git(dir, 'status', '--porcelain')).toContain(SETTINGS);
  });

  test('a dry run previews this CLI’s codemods, asks no installed CLI and writes nothing', async () => {
    const dir = await pinned();
    const { runner, asked } = withCodemods();
    const { output } = await run(dir, runner, ['--dry-run']);
    const codemods = output.data?.codemods as {
      readonly dryRun: boolean;
      readonly applied: readonly { readonly changed: readonly string[] }[];
    };
    expect(asked).toEqual([]);
    expect(codemods.dryRun).toBe(true);
    expect(codemods.applied.flatMap((one) => one.changed)).toContain(SETTINGS);
    expect(await read(dir, SETTINGS)).toBe(oldSettings());
    expect(await git(dir, 'status', '--porcelain')).toBe('');
  });

  test('a superseded workaround the hop leaves is a warning, never the verdict', async () => {
    const dir = await pinned({
      'apps/web/app/dashboard/page.tsx': [
        "import { defineRoute } from '@ultimat3/render';",
        'export const config = defineRoute({',
        "  // 'ssr', not 'stream': the framework has no hole marker yet.",
        "  render: 'ssr',",
        '});',
        '',
      ].join('\n'),
    });
    const { code, output } = await run(dir, withCodemods().runner);
    expect(code).toBe(0);
    const superseded = output.data?.superseded as readonly {
      readonly code: string;
      readonly at?: string;
    }[];
    expect(superseded.map((one) => one.code)).toEqual(['X_SUPERSEDED_WORKAROUND']);
    expect(superseded[0]?.at).toContain('apps/web/app/dashboard/page.tsx');
  });
});

describe('unit · x upgrade, already at the target', () => {
  // No version moves, and still no copy of an old template is left: every codemod is idempotent, so
  // the run asks for all of them up to the release the app is on, and the ones already done say so.
  test('the codemods up to the release it is on still run, through the installed CLI', async () => {
    // At 31.22.0 by its pins, and still holding the hook 31.22.0's template replaced.
    const dir = await pinned({}, '31.22.0');
    const { runner, asked } = withCodemods({
      versions: ['31.22.0'],
      codemods: '{"ok":false,"findings":[{"code":"X_CLI_UNKNOWN_COMMAND"}]}',
      codemodsCode: 1,
    });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(0);
    expect(asked).toEqual([
      ['upgrade', 'codemods', '--from', '0.0.0', '--to', '31.22.0', '--json'],
    ]);
    expect(output.data?.codemods).toMatchObject({ source: 'driver', from: '0.0.0', to: '31.22.0' });
    expect(await read(dir, SETTINGS)).toContain(HOOK);
  });

  test('a dry run there previews and writes nothing', async () => {
    const dir = await pinned({}, '31.22.0');
    const { runner, asked } = withCodemods({ versions: ['31.22.0'] });
    const { output } = await run(dir, runner, ['--dry-run']);
    expect(asked).toEqual([]);
    expect(output.data?.codemods).toMatchObject({ dryRun: true, from: '0.0.0' });
    expect(await read(dir, SETTINGS)).toBe(oldSettings());
  });
});

describe('unit · x upgrade codemods, by hand', () => {
  const codemods = (dir: string, ...argv: readonly string[]) =>
    run(dir, withCodemods().runner, ['codemods', ...argv]);

  test('applies the span over the app; a second run changes nothing', async () => {
    const dir = await pinned();
    const { code, output } = await codemods(dir, '--from', '31.19.0', '--to', '31.22.0');
    expect(code).toBe(0);
    const first = output.data?.codemods as {
      readonly applied: readonly { readonly id: string; readonly changed: readonly string[] }[];
    };
    expect(first.applied.map((one) => one.id)).toEqual([
      'authenticator-session-refusal',
      'format-edited-hook',
    ]);
    expect(first.applied[1]?.changed).toContain(HOOK);
    expect(await read(dir, SETTINGS)).toContain(HOOK);
    const again = await codemods(dir, '--from', '31.19.0', '--to', '31.22.0');
    const second = again.output.data?.codemods as {
      readonly applied: readonly { readonly changed: readonly string[] }[];
    };
    expect(second.applied.flatMap((one) => one.changed)).toEqual([]);
  });

  test('--dry-run writes nothing; a span that holds none runs none', async () => {
    const dir = await pinned();
    await codemods(dir, '--from', '31.19.0', '--to', '31.22.0', '--dry-run');
    expect(await read(dir, SETTINGS)).toBe(oldSettings());
    const none = await codemods(dir, '--from', '31.22.0', '--to', '31.22.0');
    expect(none.output.data?.codemods).toMatchObject({ applied: [] });
  });

  test('no --from, or one that is no release, is refused with the command to run', async () => {
    const dir = await pinned();
    for (const argv of [[], ['--from', '31.19']] as const) {
      const { code, output } = await codemods(dir, ...argv);
      expect(code).not.toBe(0);
      expect(output.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect(output.findings?.[0]?.fix).toStartWith('x upgrade codemods --from');
    }
  });

  test('--from is the codemods subcommand’s alone', async () => {
    const dir = await pinned();
    const { output } = await run(dir, withCodemods().runner, ['--from', '31.19.0']);
    expect(output.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
  });
});
