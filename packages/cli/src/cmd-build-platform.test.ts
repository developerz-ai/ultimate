// `x build --target binary --platform <bun-target>`: one artifact cross-compiled for another OS. The
// two things it must get right are the argv Bun receives and the path it REPORTS — Bun writes a
// Windows executable as `<out>.exe`, and reporting `.x/app` named a file that does not exist.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import {
  BINARY_PLATFORMS,
  binaryArgs,
  binaryOutfile,
  buildCommand,
  readPlatform,
} from './cmd-build';
import { externalArgs } from './compile-externals';
import type { Runner } from './exec';
import type { CommandResult } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { thrownBy } from './thrown-by-fixture';

describe('the platform list', () => {
  test('is the four Bun targets the docs promise, each a real `bun build --target` value', () => {
    expect(BINARY_PLATFORMS).toEqual([
      'bun-linux-x64',
      'bun-linux-arm64',
      'bun-windows-x64',
      'bun-darwin-arm64',
    ]);
  });

  test('an unknown platform is X_CLI_BAD_FLAG naming every known one and a working command', () => {
    expect(readPlatform(undefined)).toBeUndefined();
    expect(readPlatform('bun-windows-x64')).toBe('bun-windows-x64');
    const thrown = thrownBy(() => readPlatform('windows'));
    expect(thrown.code).toBe('X_CLI_BAD_FLAG');
    for (const platform of BINARY_PLATFORMS) expect(thrown.cause).toContain(platform);
    expect(thrown.fix).toBe('x build --target binary --platform bun-linux-x64');
  });
});

describe('the reported output path', () => {
  test('a Windows target gets .exe appended — once', () => {
    expect(binaryOutfile('/app/.x/app', 'bun-windows-x64', 'linux')).toBe('/app/.x/app.exe');
    expect(binaryOutfile('/app/.x/app.exe', 'bun-windows-x64', 'linux')).toBe('/app/.x/app.exe');
    expect(binaryOutfile('C:\\app\\.x\\app.EXE', 'bun-windows-x64', 'win32')).toBe(
      'C:\\app\\.x\\app.EXE',
    );
  });

  test('no --platform on a Windows host is a Windows executable too', () => {
    expect(binaryOutfile('C:\\app\\.x\\app', undefined, 'win32')).toBe('C:\\app\\.x\\app.exe');
  });

  test('a POSIX target keeps the path exactly, from any host', () => {
    expect(binaryOutfile('/app/.x/app', undefined, 'linux')).toBe('/app/.x/app');
    expect(binaryOutfile('C:\\app\\.x\\app', 'bun-linux-x64', 'win32')).toBe('C:\\app\\.x\\app');
    expect(binaryOutfile('/app/.x/app', 'bun-darwin-arm64', 'linux')).toBe('/app/.x/app');
  });
});

describe('the argv', () => {
  test('--platform reaches Bun as --target, and no platform passes no --target', () => {
    const args = binaryArgs('/app', '/out.exe', 'bun-windows-x64');
    expect(args.slice(0, 3)).toEqual(['bun', 'build', '--compile']);
    expect(args[args.indexOf('--target') + 1]).toBe('bun-windows-x64');
    expect(args[args.indexOf('--outfile') + 1]).toBe('/out.exe');
    // A cross-compiled binary carries the same allowlist as a native one.
    expect(args).toEqual(expect.arrayContaining(externalArgs()));
    expect(binaryArgs('/app', '/out')).not.toContain('--target');
  });
});

async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-platform-'));
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'plat', version: '1.0.0' }));
  await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
  await Bun.write(join(dir, 'apps/web/prerender.ts'), 'export {};\n');
  return dir;
}

async function run(argv: readonly string[]): Promise<{ result: unknown; ran: string[][] }> {
  const dir = await appRoot();
  const ran: string[][] = [];
  const runner: Runner = async (command) => {
    ran.push([...command]);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 1 };
  };
  try {
    const result = await buildCommand
      .run({ args: parseArgs(argv, SPECS), cwd: dir, runner, env: {}, bunVersion: REQUIRED_BUN })
      .then(
        (value: CommandResult) => value,
        (error: unknown) => error,
      );
    return { result, ran };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('x build --target binary --platform', () => {
  test('cross-compiles for Windows and reports the .exe it wrote', async () => {
    const { result, ran } = await run([
      'build',
      '--target',
      'binary',
      '--platform',
      'bun-windows-x64',
      '--no-preflight',
      '--out',
      '/tmp/x-build-platform-out',
    ]);
    const bun = ran.at(-1) ?? [];
    expect(bun[bun.indexOf('--target') + 1]).toBe('bun-windows-x64');
    expect(bun[bun.indexOf('--outfile') + 1]).toBe('/tmp/x-build-platform-out.exe');
    expect((result as CommandResult).data).toMatchObject({
      target: 'binary',
      platform: 'bun-windows-x64',
      artifact: '/tmp/x-build-platform-out.exe',
    });
  });

  test('an unknown platform is refused before the gate or the builder runs', async () => {
    const { result, ran } = await run(['build', '--target', 'binary', '--platform', 'win64']);
    expect(result).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(ran).toEqual([]);
  });

  test('--platform on another target is refused: only a binary is compiled for one', async () => {
    const { result, ran } = await run([
      'build',
      '--target',
      'static',
      '--platform',
      'bun-linux-x64',
    ]);
    expect(result).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((result as { cause: string }).cause).toContain('--platform');
    expect(ran).toEqual([]);
  });
});
