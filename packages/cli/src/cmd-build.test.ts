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
  buildCommand,
  buildResult,
  preflightResult,
  readTarget,
  requireEntry,
} from './cmd-build';
import { planNewApp } from './cmd-new';
import type { CommandContext } from './command';
import type { ExecResult, Runner } from './exec';
import type { CommandResult } from './output';
import { renderHuman, renderJson } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import type { StaticReport } from './static-report';
import { STATIC_REPORT_FILE, writeStaticReport } from './static-report';
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

/** An app root with the docker entry `x build --target docker` requires. */
async function buildRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-run-'));
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  await Bun.write(join(dir, 'docker', 'Dockerfile'), 'FROM oven/bun:1.3-alpine\n');
  return dir;
}

function scriptedRunner(failOn?: string): { runner: Runner; ran: string[][] } {
  const ran: string[][] = [];
  const runner: Runner = async (command) => {
    ran.push([...command]);
    const failed = failOn !== undefined && command.includes(failOn);
    return {
      command,
      code: failed ? 2 : 0,
      ok: !failed,
      stdout: '',
      stderr: failed ? `${failOn} refused` : '',
      durationMs: 5,
    };
  };
  return { runner, ran };
}

const buildContext = (argv: readonly string[], cwd: string, runner: Runner): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner,
  env: {},
  bunVersion: '1.3.0',
});

test('x build runs the static gate FIRST and only then the builder', async () => {
  const dir = await buildRoot();
  try {
    const { runner, ran } = scriptedRunner();
    const result = await buildCommand.run(buildContext(['build', '--tag', 'app:ci'], dir, runner));
    expect(result.ok).toBe(true);
    expect(result.command).toBe('build');
    // The gate's own two subprocesses come first; the docker build is last.
    expect(ran[0]).toEqual(['bunx', 'tsc', '-b', '--pretty', 'false']);
    expect(ran.at(-1)?.slice(0, 2)).toEqual(['docker', 'build']);
    expect(ran.at(-1)).toContain('app:ci');
    expect(result.data).toMatchObject({ target: 'docker', artifact: 'app:ci' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('a red static gate blocks the build — the builder is never spawned', async () => {
  const dir = await buildRoot();
  try {
    const { runner, ran } = scriptedRunner('tsc');
    const result = await buildCommand.run(buildContext(['build'], dir, runner));
    expect(result.ok).toBe(false);
    // Reported as the command the caller ran, and the artifact was never attempted.
    expect(result.command).toBe('build');
    expect(ran.some((command) => command[0] === 'docker')).toBe(false);
    expect(result.steps?.find((step) => step.name === 'typecheck')?.ok).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('--out overrides where a binary lands, and the default is .x/app', async () => {
  const dir = await buildRoot();
  try {
    await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
    const { runner: a, ran: defaulted } = scriptedRunner();
    await buildCommand.run(buildContext(['build', '--target', 'binary'], dir, a));
    expect(defaulted.at(-1)).toContain(join(dir, '.x', 'app'));
    const { runner: b, ran: overridden } = scriptedRunner();
    await buildCommand.run(
      buildContext(['build', '--target', 'binary', '--out', '/tmp/x-build-out'], dir, b),
    );
    expect(overridden.at(-1)).toContain('/tmp/x-build-out');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// #242: `x build --target static` wrote a partial site and said nothing about the difference.
// `.x/static/` looked complete, a screenshot tool was pointed at it, and "the island did not mount"
// was filed against a route that had never been in the artifact. Both renderers now say which
// routes are in it and why the rest are not.

const REPORT: StaticReport = {
  target: 'static',
  out: '/app/.x/static',
  buildId: 'b1',
  emitted: [
    { route: '/', path: '/', file: 'index.html' },
    { route: '/offline', path: '/offline', file: 'offline/index.html' },
  ],
  skipped: [
    {
      route: '/feed',
      surface: 'app',
      render: 'stream',
      reason: 'surface-forbids-static',
      why: 'app/ surface — server-rendered, not prerendered',
    },
    {
      route: '/pricing',
      surface: 'site',
      render: 'isr',
      reason: 'mode-revalidates',
      why: "render: 'isr' regenerates on a tag or ttl",
    },
  ],
};

test('a static build reports emitted and skipped, with a why per skipped route', () => {
  const built = buildResult({
    target: 'static',
    artifact: '/app/.x/static',
    command: ['bun', 'run', 'prerender.ts'],
    result: { ...exec(true), command: ['bun', 'run', 'prerender.ts'] },
    report: REPORT,
  });
  const payload = JSON.parse(renderJson(built)) as {
    data: { emitted?: readonly { route: string }[]; skipped?: readonly { why: string }[] };
  };
  expect(payload.data.emitted?.map((page) => page.route)).toEqual(['/', '/offline']);
  expect(payload.data.skipped?.map((route) => route.why)).toEqual([
    'app/ surface — server-rendered, not prerendered',
    "render: 'isr' regenerates on a tag or ttl",
  ]);
});

test('the HUMAN output says it too — a silent terminal is the same bug in a different costume', () => {
  const text = renderHuman(
    buildResult({
      target: 'static',
      artifact: '/app/.x/static',
      command: ['bun', 'run', 'prerender.ts'],
      result: { ...exec(true), command: ['bun', 'run', 'prerender.ts'] },
      report: REPORT,
    }),
  );
  // The route that produced the false bug report, and the reason it was never in the directory.
  expect(text).toContain('/feed');
  expect(text).toContain('app/ surface');
  expect(text).toContain('index.html');
  expect(text).toContain('built static');
});

test('a target with no inventory carries no emitted/skipped keys at all', () => {
  const payload = JSON.parse(
    renderJson(
      buildResult({
        target: 'docker',
        artifact: 'app:dev',
        command: ['docker', 'build'],
        result: exec(true),
      }),
    ),
  ) as { data: Record<string, unknown> };
  expect('emitted' in payload.data).toBe(false);
  expect('skipped' in payload.data).toBe(false);
});

test('a PREVIOUS build’s inventory is never reported as this one’s', async () => {
  const dir = await buildRoot();
  try {
    await Bun.write(join(dir, 'apps/web/prerender.ts'), 'export {};\n');
    await writeStaticReport(dir, { ...REPORT, buildId: 'stale' });
    // This runner spawns nothing real, so it writes no report — the stale one must not survive.
    const { runner } = scriptedRunner();
    const result = await buildCommand.run(
      buildContext(['build', '--target', 'static'], dir, runner),
    );
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>)['emitted']).toBeUndefined();
    expect(await Bun.file(join(dir, STATIC_REPORT_FILE)).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('x build --target static reads the inventory the prerenderer just wrote', async () => {
  const dir = await buildRoot();
  try {
    await Bun.write(join(dir, 'apps/web/prerender.ts'), 'export {};\n');
    const runner: Runner = async (command) => {
      if (command.includes(join(dir, 'apps/web/prerender.ts'))) {
        await writeStaticReport(dir, { ...REPORT, out: join(dir, '.x', 'static') });
      }
      return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 3 };
    };
    const result = await buildCommand.run(
      buildContext(['build', '--target', 'static'], dir, runner),
    );
    const data = result.data as { skipped?: readonly { route: string; reason: string }[] };
    expect(data.skipped?.map((route) => route.route)).toEqual(['/feed', '/pricing']);
    // Two causes, kept apart: an app/ route and an isr site/ route are not skipped for one reason.
    expect(data.skipped?.map((route) => route.reason)).toEqual([
      'surface-forbids-static',
      'mode-revalidates',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
