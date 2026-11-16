#!/usr/bin/env bun
// Cut a superseded major's maintenance lane (SECURITY.md): `release/<major>.x` on origin at the
// last `v<major>.*` tag, and `maint-<major>` on every publishable package at the newest version of
// that major npm already holds. Idempotent — a step already true is `done` — so a run that died on
// an expired OTP is re-run, never repaired by hand. A maintainer runs it, with credentials.
//
//   bun run scripts/release-maint.ts --major 30 [--dry-run] [--json]
//   NPM_CONFIG_OTP=<code> bun run scripts/release-maint.ts --major 30 --json

import { renderFixShellArg } from '@ultimat3/core';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { Changelog } from './lib/changelog-sections';
import { loadChangelog } from './lib/changelog-store';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import {
  cutBranchCommand,
  distTagCommand,
  lastTagOfMajor,
  maintWindows,
  newestOfMajor,
  windowOpen,
} from './lib/release-maint';
import type { RunResult } from './lib/run';
import { repoRoot, run } from './lib/run';
import { todayUtc } from './lib/stability-findings';
import { listWorkspaces, publishOrder } from './lib/workspaces';
import { defaultFetch, lookup, REQUEST_TIMEOUT_MS, type RegistryFetch } from './registry-audit';

const SCRIPT = 'release-maint';
const FLAGS = ['major', 'dry-run', 'json'] as const;

export interface MaintLaneSeams {
  readonly changelog: Changelog;
  readonly today: string;
  readonly packages: readonly string[];
  readonly git: (args: readonly string[]) => Promise<RunResult>;
  readonly fetch: RegistryFetch;
  readonly exec: (argv: readonly string[]) => Promise<RunResult>;
}

interface Step {
  readonly kind: 'branch' | 'dist-tag';
  readonly target: string;
  readonly state: 'pending' | 'done';
  readonly command: string;
  readonly argv: readonly string[];
}

const rerun = (major: number): string => `bun run scripts/release-maint.ts --major ${major} --json`;

const refused = (summary: string, findings: readonly Finding[]): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary,
  findings,
});

const refusal = (cause: string, fix: string): Finding => ({
  code: 'X_MAINT_LANE_REFUSED',
  cause,
  fix,
  at: 'scripts/release-maint.ts',
});

export async function maintLaneResult(
  input: { readonly major: number; readonly dryRun: boolean },
  seams: MaintLaneSeams,
): Promise<ScriptResult> {
  const windows = maintWindows(seams.changelog);
  const window = windows.find((one) => one.major === input.major);
  if (window === undefined || !windowOpen(window, seams.today)) {
    const open = windows.find((one) => windowOpen(one, seams.today));
    return refused(`no maintenance lane to cut for ${input.major}.x`, [
      refusal(
        window === undefined
          ? `${input.major}.x is owed no maintenance lane: SECURITY.md promises one to a major from v30 once its successor has shipped, and docs/changelog/ shows no such successor`
          : `${input.major}.x's maintenance window closed on ${window.closesOn} (six months after ${window.successor}); today is ${seams.today}`,
        open === undefined
          ? 'ls docs/changelog/ | sort -V | tail -3   # no major is inside its window: nothing to cut'
          : `bun run scripts/release-maint.ts --major ${renderFixShellArg(String(open.major), '<major>')} --dry-run --json`,
      ),
    ]);
  }
  const tags = await seams.git(['ls-remote', '--tags', 'origin', `refs/tags/v${input.major}.*`]);
  const from = tags.ok ? lastTagOfMajor(tags.output, input.major) : undefined;
  const heads = await seams.git(['ls-remote', '--heads', 'origin', window.branch]);
  if (from === undefined || !heads.ok) {
    return refused(`cannot cut ${window.branch}`, [
      refusal(
        !heads.ok || !tags.ok
          ? 'git ls-remote could not read origin, so neither the tag to cut from nor an existing branch is known'
          : `origin has no v${input.major}.Y.Z tag to cut ${window.branch} from`,
        `git ls-remote --tags origin 'refs/tags/v${renderFixShellArg(String(input.major), '<major>')}.*'`,
      ),
    ]);
  }
  const branchArgv = cutBranchCommand(window, from.sha);
  const steps: Step[] = [
    {
      kind: 'branch',
      target: window.branch,
      state: heads.output.trim() === '' ? 'pending' : 'done',
      command: branchArgv.join(' '),
      argv: branchArgv,
    },
  ];
  const skipped: string[] = [];
  const unreachable: Finding[] = [];
  for (const name of seams.packages) {
    const found = await lookup(name, seams.fetch, REQUEST_TIMEOUT_MS);
    if (found.kind === 'unreachable') {
      unreachable.push({
        code: 'X_REGISTRY_UNREACHABLE',
        cause: `the registry did not answer for ${name}: ${found.detail}`,
        fix: rerun(input.major).replace('--json', '--dry-run --json'),
        at: name,
      });
      continue;
    }
    const packument = found.kind === 'found' ? found.packument : undefined;
    const version = newestOfMajor(Object.keys(packument?.versions ?? {}), input.major);
    if (version === undefined) {
      skipped.push(`  skip      ${name}: no ${input.major}.x version on npm`);
      continue;
    }
    const argv = distTagCommand(name, version, window.distTag);
    const held = packument?.['dist-tags']?.[window.distTag] === version;
    steps.push({
      kind: 'dist-tag',
      target: name,
      state: held ? 'done' : 'pending',
      command: argv.join(' '),
      argv,
    });
  }
  if (unreachable.length > 0)
    return refused('the registry did not answer: nothing ran', unreachable);

  const ran: string[] = [];
  for (const step of input.dryRun ? [] : steps.filter((one) => one.state === 'pending')) {
    const result = await seams.exec(step.argv);
    if (!result.ok) {
      return {
        ...refused(`stopped at ${step.target} after ${ran.length} write(s)`, [
          {
            code: 'X_MAINT_LANE_WRITE_FAILED',
            cause: `\`${step.command}\` failed: ${result.output.trim().split('\n')[0] ?? 'no output'}`,
            fix: `${rerun(input.major)}   # done steps are skipped; npm wants a fresh NPM_CONFIG_OTP`,
            at: step.target,
          },
        ]),
        lines: ran.map((command) => `  ran       ${command}`),
      };
    }
    ran.push(step.command);
  }
  const pending = steps.filter((step) => step.state === 'pending').length;
  return {
    ok: true,
    script: SCRIPT,
    summary: input.dryRun
      ? `would run ${pending} write(s) for the ${input.major}.x lane (open until ${window.closesOn})`
      : `${window.branch} and ${window.distTag} are in place: ${ran.length} write(s) run`,
    lines: [...steps.map((step) => `  ${step.state.padEnd(9)} ${step.command}`), ...skipped],
    data: {
      major: input.major,
      branch: window.branch,
      distTag: window.distTag,
      closesOn: window.closesOn,
      fromTag: from.tag,
      dryRun: input.dryRun,
      steps: steps.map(({ argv: _argv, ...step }) => step),
      ran,
    },
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: FLAGS,
    refuse: (unknown, flags) =>
      report(
        refused(`refusing: ${unknown.length} unknown flag(s)`, [
          {
            code: 'X_CLI_BAD_FLAG',
            cause: `--${unknown.join(', --')} is not a flag of scripts/release-maint.ts (known: ${FLAGS.join(', ')})`,
            fix: 'bun run scripts/release-maint.ts --major 30 --dry-run --json',
            at: 'scripts/release-maint.ts',
          },
        ]),
        flags.get('json') === true,
      ),
  });
  const major = Number.parseInt(flagString(args, 'major') ?? '', 10);
  if (!Number.isInteger(major) || String(major) !== flagString(args, 'major')) {
    report(
      refused('refusing: --major is not a major version number', [
        {
          code: 'X_CLI_BAD_FLAG',
          cause: `--major ${flagString(args, 'major') ?? '(absent)'} is not a whole major number`,
          fix: 'bun run scripts/release-maint.ts --major 30 --dry-run --json',
          at: 'scripts/release-maint.ts',
        },
      ]),
      args.json,
    );
  }
  const root = repoRoot();
  const exec = (argv: readonly string[]) => run([...argv], { cwd: root });
  report(
    await maintLaneResult(
      { major, dryRun: flagBool(args, 'dry-run') },
      {
        changelog: await loadChangelog(root),
        today: todayUtc(),
        packages: publishOrder(await listWorkspaces(root)).map((workspace) => workspace.name),
        git: (gitArgs) => run(['git', ...gitArgs], { cwd: root }),
        fetch: defaultFetch,
        exec,
      },
    ),
    args.json,
  );
}
