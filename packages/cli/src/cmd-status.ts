// `x status`: what the running deployment is, from what it already records — every live worker's
// row in `x_job_workers` (stamped with its build), and the build each `--url` origin answers
// `/readyz` with. A read, never a verdict: `x deploy verify` is the gate on one build being out.

import type { WorkerRecord } from '@ultimat3/jobs';
import { requireAppRoot } from './app-root';
import { printableBuild } from './cmd-deploy-verify-sample';
import { type OriginReport, sampleOrigin, statusOrigin } from './cmd-status-sample';
import { STATUS_DEFAULT_SAMPLES, STATUS_MAX_SAMPLES, statusSpec } from './cmd-status-spec';
import type { CliCommand, CommandContext } from './command';
import { UNKNOWN_BUILD } from './deploy-verify-grade';
import { parseIntFlag } from './flag-number';
import { withJobDriver } from './jobs-driver';
import { workerToJson } from './jobs-json';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagList, flagString } from './parse';

/**
 * Roles whose build no fleet-wide record holds. A sync node keeps its clients' builds in its own
 * memory (the `/_x` live panel reads them in `x dev`), the scheduler and the replicator write no
 * row, and the web pods are only ever sampled. Each answers `/readyz` with its build, so naming its
 * origin in `--url` is how it is read. `migrate` runs once and exits: there is nothing running.
 */
export const UNRECORDED_ROLES = ['web', 'sync', 'scheduler', 'replicator'] as const;

function readSamples(ctx: CommandContext): number {
  const raw = flagString(ctx.args, 'samples');
  if (raw === undefined) return STATUS_DEFAULT_SAMPLES;
  return parseIntFlag(raw, {
    name: 'samples',
    command: 'status',
    min: 1,
    max: STATUS_MAX_SAMPLES,
    example: 'x status --url https://app.example.com --samples 5 --json',
  });
}

function workersData(workers: readonly WorkerRecord[]): { readonly [key: string]: JsonValue } {
  const byBuild = new Map<string, number>();
  for (const worker of workers) {
    // Printed: a row's stamp passes the same screen a stranger's `/readyz` header does.
    const build = worker.build === undefined ? UNKNOWN_BUILD : printableBuild(worker.build);
    byBuild.set(build, (byBuild.get(build) ?? 0) + 1);
  }
  return {
    count: workers.length,
    draining: workers.filter((worker) => worker.drainingAt !== undefined).length,
    // `fromEntries` DEFINES each key: a build id is written by whoever stamped the image.
    byBuild: Object.fromEntries(byBuild),
    rows: workers.map((worker) => ({
      ...(workerToJson(worker) as { readonly [key: string]: JsonValue }),
      build: worker.build === undefined ? null : printableBuild(worker.build),
      draining: worker.drainingAt !== undefined,
    })),
  };
}

const originJson = (report: OriginReport): JsonValue => ({
  origin: report.origin,
  samples: report.samples,
  roles: [...report.roles],
  byBuild: { ...report.byBuild },
  byStatus: { ...report.byStatus },
  unstamped: report.unstamped,
});

/** `name: count` pairs, most first: the human line of a distribution. */
const spread = (counts: Readonly<Record<string, number>>): string => {
  const pairs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return pairs.length === 0 ? '—' : pairs.map(([key, count]) => `${key} ×${count}`).join(', ');
};

export const statusCommand: CliCommand = {
  spec: statusSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('status', ctx.cwd).dir;
    // Flags first, so a typo costs neither a database connection nor a request.
    const origins = flagList(ctx.args, 'url').map(statusOrigin);
    const samples = readSamples(ctx);
    const reports: OriginReport[] = [];
    for (const origin of origins) reports.push(await sampleOrigin(origin, samples));
    // The queue `x jobs list` reads, through the same boot: one answer to "which database".
    return withJobDriver(root, ctx, async (driver) => {
      const workers = (await driver.introspect?.workers()) ?? [];
      const data = workersData(workers);
      const lines = [
        `  ${msg('cli.status.workers', { count: workers.length, builds: spread(data['byBuild'] as Record<string, number>) })}`,
        ...reports.map(
          (report) =>
            `  ${msg('cli.status.origin', { origin: report.origin, samples: report.samples, builds: spread(report.byBuild), statuses: spread(report.byStatus) })}`,
        ),
        `  ${msg('cli.status.unrecorded', { roles: UNRECORDED_ROLES.join(', ') })}`,
      ];
      return {
        ok: true,
        command: 'status',
        summary: msg('cli.status.summary', { workers: workers.length, origins: reports.length }),
        lines,
        data: {
          workers: data,
          origins: reports.map(originJson),
          unrecorded: [...UNRECORDED_ROLES],
        },
      };
    });
  },
};
