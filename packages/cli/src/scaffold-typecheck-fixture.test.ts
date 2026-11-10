// The scaffold typecheck's harness, with the compiler injected: which file is the compiler, which
// kind of link lends the sandbox the workspace's node_modules, what the sandbox holds when `tsc`
// runs, and that it is gone after. The real `tsc` over a real scaffold is the contract suite's.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no realpath and no synchronous existence check for a directory.
import { existsSync, realpathSync } from 'node:fs';
// why: Bun ships no path-join API; the expected fallback is built the way the harness builds it.
import { join } from 'node:path';
import { ScaffoldPathEscapeError } from './errors';
import type { ExecResult, Runner } from './exec';
import {
  DIR_LINK,
  sandboxPath,
  typecheckScaffold,
  workspaceRoot,
  workspaceTsc,
} from './scaffold-typecheck-fixture';

describe('workspaceTsc', () => {
  test('is a file that exists on this host — tsc.exe on Windows, where no bare tsc is linked', async () => {
    expect(await Bun.file(workspaceTsc(workspaceRoot())).exists()).toBe(true);
  });

  test('a root with no install answers the path bun install would write', () => {
    const root = join(workspaceRoot(), 'no-such-dir');
    expect(workspaceTsc(root)).toBe(join(root, 'node_modules', '.bin', 'tsc'));
  });
});

describe('DIR_LINK', () => {
  test('is a junction on Windows, where a dir symlink needs Developer Mode', () => {
    expect(DIR_LINK).toBe(process.platform === 'win32' ? 'junction' : 'dir');
  });
});

describe('typecheckScaffold, the compiler injected', () => {
  const files = [{ path: 'apps/web/app/page.tsx', contents: 'export const page = 1;\n' }];
  interface Seen {
    command: readonly string[];
    cwd: string;
    overlay: unknown;
    page: string;
    linked: string;
  }

  const recording = (stdout: string): { runner: Runner; seen: Seen[] } => {
    const seen: Seen[] = [];
    const runner: Runner = async (command, options) => {
      const cwd = options.cwd ?? '';
      seen.push({
        command,
        cwd,
        overlay: await Bun.file(join(cwd, 'tsconfig.scaffold-check.json')).json(),
        page: await Bun.file(join(cwd, 'apps/web/app/page.tsx')).text(),
        linked: realpathSync(join(cwd, 'node_modules')),
      });
      const result: ExecResult = {
        command,
        code: stdout === '' ? 0 : 2,
        ok: stdout === '',
        stdout,
        stderr: '',
        durationMs: 1,
      };
      return result;
    };
    return { runner, seen };
  };

  test('tsc runs over the overlay in a sandbox holding the files and the borrowed install', async () => {
    const { runner, seen } = recording(
      "apps/web/app/page.tsx(1,14): error TS2322: Type 'number' is not assignable.\nerror TS5023: Unknown compiler option 'x'.\n",
    );
    const report = await typecheckScaffold({ files, app: 'probe', runner });

    const [call] = seen;
    if (call === undefined) return expect.unreachable('the injected compiler was never called');
    expect(call.command).toEqual([
      workspaceTsc(workspaceRoot()),
      '--noEmit',
      '--pretty',
      'false',
      '-p',
      'tsconfig.scaffold-check.json',
    ]);
    expect(call.page).toBe('export const page = 1;\n');
    expect(call.linked).toBe(realpathSync(join(workspaceRoot(), 'node_modules')));
    // Only where imports resolve may change: the app's own tsconfig is extended, never replaced.
    expect(call.overlay).toMatchObject({
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: true,
        paths: {
          '@ultimat3/*': [`${workspaceRoot()}/packages/*/src`],
          '@probe/web/*': ['./apps/web/*'],
          '@probe/*': ['./packages/*/src'],
        },
      },
    });

    expect(report.fileCount).toBe(1);
    expect(report.diagnostics).toEqual([
      {
        file: 'apps/web/app/page.tsx',
        line: 1,
        code: 'TS2322',
        message: "Type 'number' is not assignable.",
      },
      { file: '', line: 0, code: 'TS5023', message: "Unknown compiler option 'x'." },
    ]);
    // The sandbox is removed unless `keep` asked for it.
    expect(existsSync(report.dir)).toBe(false);
  });

  test('a generated path outside the sandbox is refused before anything is written', async () => {
    const { runner, seen } = recording('');
    const thrown = await typecheckScaffold({
      files: [{ path: '../x-scaffold-typecheck-escape.ts', contents: 'x' }],
      runner,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(ScaffoldPathEscapeError);
    expect(seen).toEqual([]);
    expect(sandboxPath('/sandbox', 'apps/web/a.ts')).toBe(join('/sandbox', 'apps/web/a.ts'));
  });
});
