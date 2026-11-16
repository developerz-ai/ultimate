// `x repro <id>` — a production failure becomes a failing test. A dead job (its row, its steps) or
// a captured 5xx (`x_failures`, when `failureCapture` is on) is read, `--write` puts the replay in
// `repro/`, `--verify` runs it, `--list` shows what is held, `--bundle` writes the redacted archive
// an issue carries. CLI wiring only: reads `repro-bundle.ts`, archive `repro-archive-write.ts`.

import { postgresErrorGroupsStore } from '@ultimat3/admin/error-groups';
import { renderFixShellArg } from '@ultimat3/core';
import { postgresFailureStore } from '@ultimat3/db';
import { loadAppConfig } from './app-config-load';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { reproSpec } from './cmd-repro-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { withJobDriver } from './jobs-driver';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { findingFrom } from './output';
import { flagBool, flagString } from './parse';
import { errorFromFile, errorFromStore } from './repro-archive-collect';
import { writeBundle } from './repro-archive-write';
import type { ReproSubject } from './repro-bundle';
import { resolveSubject, subjectFromFile } from './repro-bundle';
import { ReproNotReproducedError } from './repro-errors';
import { jobFingerprint } from './repro-job';
import { reproFile, reproSource, verifyRepro, writeRepro } from './repro-write';

/** What every answer carries, whichever kind: the code, the group, the build and what was masked. */
function factsOf(subject: ReproSubject): {
  code: string | null;
  fingerprint: string | null;
  build: string | null;
  masked: readonly string[];
} {
  if (subject.kind === 'job') {
    const { failure } = subject;
    return {
      code: failure.code,
      fingerprint: jobFingerprint(failure),
      build: null,
      masked: failure.masked,
    };
  }
  const { bundle } = subject;
  return {
    code: bundle.code,
    fingerprint: bundle.fingerprint,
    build: bundle.build,
    masked: bundle.masked,
  };
}

const summaryOf = (subject: ReproSubject): string =>
  subject.kind === 'job'
    ? msg('cli.repro.job', {
        name: subject.failure.name,
        id: subject.failure.jobId,
        code: subject.failure.code ?? 'no code',
        step: subject.failure.step ?? '(the body)',
      })
    : msg('cli.repro.request', {
        primitive: subject.bundle.primitive,
        name: subject.bundle.name,
        code: subject.bundle.code,
        fingerprint: subject.bundle.fingerprint,
      });

async function answer(
  root: string,
  ctx: CommandContext,
  id: string,
  subject: ReproSubject,
): Promise<CommandResult> {
  const facts = factsOf(subject);
  const payload = (subject.kind === 'job'
    ? subject.failure
    : subject.bundle) as unknown as JsonValue;
  const base = {
    kind: subject.kind,
    id,
    code: facts.code,
    fingerprint: facts.fingerprint,
    build: facts.build,
    masked: [...facts.masked],
    [subject.kind === 'job' ? 'failure' : 'bundle']: payload,
  };
  const verify = flagBool(ctx.args, 'verify');
  if (!verify && !flagBool(ctx.args, 'write')) {
    return { ok: true, command: 'repro', summary: summaryOf(subject), data: base };
  }
  const file = reproFile(subject);
  const runningBuild = ctx.env['BUILD_ID'] ?? null;
  await writeRepro(root, file, await reproSource(root, subject, id, runningBuild), ctx.runner);
  const lines = [msg('cli.repro.written', { file })];
  if (!verify) {
    return {
      ok: true,
      command: 'repro',
      summary: summaryOf(subject),
      lines,
      data: { ...base, file },
    };
  }
  const verdict = await verifyRepro(root, file, facts.code, ctx.runner, ctx.env);
  const data = { ...base, file, reproduced: verdict.reproduced, got: verdict.got };
  if (verdict.reproduced) {
    lines.push(msg('cli.repro.reproduced', { file, code: facts.code ?? '' }));
    return { ok: true, command: 'repro', summary: summaryOf(subject), lines, data };
  }
  lines.push(msg('cli.repro.notReproduced', { file, got: verdict.got ?? 'a pass' }));
  const refusal = new ReproNotReproducedError({
    id,
    expected: facts.code ?? 'its original failure',
    got: verdict.got,
    masked: facts.masked,
    file,
    build: facts.build,
  });
  return {
    ok: false,
    command: 'repro',
    summary: summaryOf(subject),
    lines,
    findings: [findingFrom(refusal)],
    data,
  };
}

/** The held bundles, each with its group's count and last sighting from `x_error_groups`. */
async function list(ctx: CommandContext): Promise<CommandResult> {
  const code = flagString(ctx.args, 'code');
  const bundles = await postgresFailureStore().list(code === undefined ? {} : { code });
  const groups = postgresErrorGroupsStore();
  const rows: JsonValue[] = [];
  for (const bundle of bundles) {
    const group = await groups.get(bundle.fingerprint).catch(() => undefined);
    rows.push({
      ...bundle,
      count: group?.count ?? null,
      lastSeen: group?.lastSeen ?? null,
      repro: `x repro ${bundle.id} --write --verify`,
    });
  }
  return {
    ok: true,
    command: 'repro',
    summary: msg('cli.repro.listed', { count: rows.length }),
    lines: bundles.map(
      (bundle) => `  ${bundle.at}  ${bundle.code.padEnd(28)} ${bundle.name}  ${bundle.id}`,
    ),
    data: { bundles: rows },
  };
}

export const reproCommand: CliCommand = {
  spec: reproSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('repro', ctx.cwd).dir;
    const from = flagString(ctx.args, 'from');
    const id = ctx.args.positionals[0];
    if (from === undefined && id === undefined && !flagBool(ctx.args, 'list')) {
      throw new MissingPositionalError({
        command: 'repro',
        positional: 'id',
        example: 'x repro --list --json',
      });
    }
    const bundle = flagBool(ctx.args, 'bundle');
    const includeRows = flagBool(ctx.args, 'include-rows');
    if (includeRows && !bundle) {
      throw new BadFlagError({
        flag: 'include-rows',
        command: 'repro',
        reason: 'it chooses what a bundle carries, and no --bundle was asked for',
        fix:
          id === undefined
            ? 'x repro --from <file> --bundle --include-rows'
            : `x repro ${renderFixShellArg(id, '<id>')} --bundle --include-rows`,
      });
    }
    if (bundle && (flagBool(ctx.args, 'write') || flagBool(ctx.args, 'verify'))) {
      throw new BadFlagError({
        flag: 'bundle',
        command: 'repro',
        reason: 'a bundle is written for an issue, and --write/--verify run the test in this app',
        fix:
          id === undefined
            ? 'x repro --from <file> --bundle'
            : `x repro ${renderFixShellArg(id, '<id>')} --bundle`,
      });
    }
    // The app's declarations are what mask a job's input and what a written test replays against.
    await loadApp(root);
    if (from !== undefined) {
      const subject = await subjectFromFile(from);
      if (bundle) {
        return writeBundle(root, ctx, subject, await errorFromFile(from), { includeRows });
      }
      return answer(root, ctx, id ?? from, subject);
    }
    const captureOn = (await loadAppConfig(root))?.failureCapture.enabled === true;
    return withJobDriver(root, ctx, async (driver) => {
      if (id === undefined) return list(ctx);
      const subject = await resolveSubject(driver, id, captureOn);
      if (bundle) {
        const error = await errorFromStore(driver, subject);
        return writeBundle(root, ctx, subject, error, { includeRows });
      }
      return answer(root, ctx, id, subject);
    });
  },
};
