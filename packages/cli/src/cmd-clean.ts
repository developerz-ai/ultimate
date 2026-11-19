// `x clean` — every test leftover the framework knows of, cleared on demand (#738): the same
// sweep the test runner makes before every run, keeping none.
//
// The set: the migrated test-database templates under `.x/test-db`, the whole `.x/cache`, the `.x`
// folders a process started in a source folder once wrote beside the code, and — with
// `TEST_DATABASE_URL` set — the probe databases whose run is over. The test runner sweeps the same
// set before every run, keeping the newest two of each cache (`test-housekeeping.ts`); this is the
// same sweep, keeping none. Never touched: `.x/pgdata` (the dev database), `.x/storage`, the build
// output. `--services` adds this checkout's test stack (`clean-services.ts`).

import { requireAppRoot } from './app-root';
import { cleanServices } from './clean-services';
import { cleanSpec } from './cmd-clean-spec';
import type { CliCommand, CommandContext } from './command';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool } from './parse';
import { tidyTestState } from './test-housekeeping';

export const cleanCommand: CliCommand = {
  spec: cleanSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('clean', ctx.cwd).dir;
    const dryRun = flagBool(ctx.args, 'dry-run');
    const report = await tidyTestState({ root, mode: 'all', env: ctx.env, dryRun });
    const count = report.paths.length + report.databases.length;
    const services = flagBool(ctx.args, 'services')
      ? await cleanServices({ root, runner: ctx.runner, dryRun })
      : undefined;
    const finding = services?.finding;
    return {
      ok: finding === undefined,
      command: 'clean',
      summary:
        finding !== undefined
          ? finding.cause
          : count === 0
            ? msg('cli.clean.nothing')
            : msg(dryRun ? 'cli.clean.would' : 'cli.clean.removed', {
                paths: report.paths.length,
                databases: report.databases.length,
              }),
      ...(finding === undefined ? {} : { findings: [finding] }),
      ...(services === undefined ? {} : { lines: [...services.lines] }),
      data: {
        dryRun,
        paths: [...report.paths],
        databases: [...report.databases],
        ...(services === undefined ? {} : { services: services.data }),
      },
    };
  },
};
