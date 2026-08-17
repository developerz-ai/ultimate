import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameworkVersion, VERSION_DEFINE } from '@ultimat3/core';
import {
  argsFor,
  BUILD_ENTRY,
  BUILD_TARGETS,
  binaryArgs,
  buildResult,
  preflightResult,
  readTarget,
  requireEntry,
} from './cmd-build';
import { planNewApp } from './cmd-new';
import type { ExecResult } from './exec';
import type { CommandResult } from './output';
import { renderJson } from './output';
import type { ThrownShape } from './thrown-by';
import { thrownBy } from './thrown-by';

test('every build target has an entry, and `x new` writes every one of them', () => {
  const scaffolded = new Set(planNewApp({ name: 'entry-app', example: true }).map((f) => f.path));
  for (const target of BUILD_TARGETS) {
    // This is the bug the table exists to prevent: `binary` compiled `apps/web/server.ts` and
    // `static` ran `apps/web/prerender.ts` while `x new` wrote neither, so a scaffolded app had
    // no deployable artifact at all.
    expect(scaffolded.has(BUILD_ENTRY[target])).toBe(true);
  }
});

test('the spawned command names the same file the entry check required', () => {
  const root = '/app';
  for (const target of BUILD_TARGETS) {
    expect(argsFor(target, { root, tag: 't', out: '/out' }).join(' ')).toContain(
      join(root, BUILD_ENTRY[target]),
    );
  }
});

test('a missing entry is refused by name, before anything is spawned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-'));
  try {
    const thrown: ThrownShape = thrownBy(() => requireEntry(dir, 'binary'));
    expect(thrown.code).toBe('X_BUILD_ENTRY_MISSING');
    expect(thrown.cause).toContain('apps/web/server.ts');
    expect(thrown.fix).toContain('apps/web/server.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry that is present resolves to its absolute path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-'));
  try {
    await Bun.write(join(dir, 'docker/Dockerfile'), 'FROM oven/bun:1.3-alpine\n');
    expect(requireEntry(dir, 'docker')).toBe(join(dir, 'docker', 'Dockerfile'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the binary target defines the version the executable has no manifest to read', () => {
  // The bug this pins: without the define, `frameworkVersion()` finds no `package.json` inside
  // `/$bunfs` and the artifact throws before any role starts. `packages/core/e2e/version.e2e.test.ts`
  // compiles and runs both halves; this one holds the flag that connects them.
  const args = binaryArgs('/app', '/out');
  const at = args.indexOf('--define');
  expect(at).toBeGreaterThan(-1);
  expect(args[at + 1]).toBe(`${VERSION_DEFINE}="${frameworkVersion()}"`);
  expect(args[at + 1]).toMatch(/^ULTIMATE_FRAMEWORK_VERSION="\d+\.\d+\.\d+/);
});

const exec = (ok: boolean): ExecResult => ({
  command: ['docker', 'build'],
  code: ok ? 0 : 1,
  ok,
  stdout: 'Step 1/9 : FROM oven/bun:1.3-alpine',
  stderr: ok ? '' : 'ERROR: failed to solve: process did not complete successfully',
  durationMs: 12,
});

test('a failed build says so in its summary line, not "built docker"', () => {
  const failed = buildResult({
    target: 'docker',
    artifact: 'app:dev',
    command: ['docker', 'build'],
    result: exec(false),
  });
  expect(failed.ok).toBe(false);
  // The bug: `summary` was `msg('cli.build.done')` unconditionally, so a build that exited 1
  // printed `✗ built docker` — and every reader whose channel is the summary line read a success.
  expect(failed.summary).not.toContain('built');
  expect(
    buildResult({
      target: 'docker',
      artifact: 'app:dev',
      command: ['docker', 'build'],
      result: exec(true),
    }).summary,
  ).toBe('built docker');
});

test("a failed build's own output reaches --json, not only the terminal", () => {
  const failed = buildResult({
    target: 'docker',
    artifact: 'app:dev',
    command: ['docker', 'build'],
    result: exec(false),
  });
  // `lines` is declared human-only and "never carries data JSON does not have" — and `renderJson`
  // drops it. The builder's own stderr was therefore invisible to CI, which runs `--json`.
  const payload = JSON.parse(renderJson(failed)) as { data: { output?: string } };
  expect(payload.data.output).toContain('failed to solve');
  expect(failed.lines?.join('\n')).toContain('failed to solve');
});

test('a build blocked by the static gate still reports as the build command', () => {
  const verify: CommandResult = {
    ok: false,
    command: 'verify',
    summary: '1 of 6 steps failed',
    steps: [{ name: 'lint', ok: false, durationMs: 3, findings: [] }],
  };
  // An agent keys `--json` off `command`: a `build` that answers `"command":"verify"` sends it to
  // re-run a gate it never asked for, and hides that the build never started.
  expect(preflightResult(verify).command).toBe('build');
  expect(preflightResult(verify).steps).toBe(verify.steps);
  expect(preflightResult(verify).ok).toBe(false);
});

test('an unknown target names the known ones and a working invocation', () => {
  expect(readTarget(undefined)).toBe('docker');
  const thrown: ThrownShape = thrownBy(() => readTarget('lambda'));
  expect(thrown.code).toBe('X_CLI_UNKNOWN_COMMAND');
  expect(thrown.fix).toBe('x build --target docker');
});
