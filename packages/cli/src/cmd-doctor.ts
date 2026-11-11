// `x doctor` command orchestration and result rendering. Machine facts and ordered diagnostics live
// in focused concern modules so this command only assembles the stable CLI result.

import { doctorSpec } from './cmd-doctor-spec';
import type { CliCommand, CommandContext } from './command';
import { chartAlertsProbe, withChartAlertsListing } from './doctor-chart-alerts';
import { runDoctor } from './doctor-checks';
import { coverageExcludesProbe, withCoverageExcludes } from './doctor-coverage';
import { shippedGuardsProbe, withGuardListing } from './doctor-guards';
import { NO_POOLER_FACT, withPoolerReport } from './doctor-pooler';
import { doctorPort } from './doctor-ports';
import { probeFor } from './doctor-probe';
import { rollingSinceProbe, withRollingReminder } from './doctor-rolling';
import { msg } from './messages';
import type { CommandResult } from './output';

export const doctorCommand: CliCommand = {
  spec: doctorSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const port = doctorPort(ctx.args, ctx.env);
    const probe = probeFor(ctx.cwd, ctx.bunVersion, port, ctx.env);
    const pooler = probe.root === undefined ? NO_POOLER_FACT : await probe.pooler();
    const findings = await runDoctor({ ...probe, pooler: async () => pooler });
    const listed = withGuardListing(
      {
        ok: findings.length === 0,
        command: 'doctor',
        summary:
          findings.length === 0
            ? msg('cli.doctor.clean')
            : msg('cli.doctor.findings', { count: findings.length }),
        findings,
        data: { count: findings.length, codes: findings.map((entry) => entry.code) },
      },
      probe.root === undefined ? [] : await shippedGuardsProbe(probe.root),
    );
    const covered = withCoverageExcludes(
      listed,
      probe.root === undefined ? [] : await coverageExcludesProbe(probe.root),
    );
    const charted = withChartAlertsListing(
      covered,
      probe.root === undefined ? [] : chartAlertsProbe(probe.root),
    );
    return withPoolerReport(
      withRollingReminder(
        charted,
        probe.root === undefined ? undefined : await rollingSinceProbe(probe.root),
      ),
      pooler,
    );
  },
};
