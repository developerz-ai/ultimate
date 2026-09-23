// The command registry: the one list the parser, the help catalogue and the dispatcher all read.
// A command that is not here does not exist — there is no second place to register one.
//
// LAZY, `As of 2026-09-23`: every declaration is static (`cmd-<name>-spec.ts`) and every body is
// `await import()`ed when that command runs. Importing all 28 bodies to answer one of them was
// the CLI's whole startup: `x --help` paid for `sass`, Babel, every framework package and the
// dev server it never started (plan 101 slice 12 d).

import { affectedSpec } from './cmd-affected-spec';
import { buildSpec } from './cmd-build-spec';
import { ciSpec } from './cmd-ci-spec';
import { dbSpec } from './cmd-db-spec';
import { deploySpec } from './cmd-deploy-spec';
import { devSpec } from './cmd-dev-spec';
import { docsSpec } from './cmd-docs-spec';
import { doctorSpec } from './cmd-doctor-spec';
import { envSpec } from './cmd-env-spec';
import { errorsSpec } from './cmd-errors-spec';
import { fixSpec } from './cmd-fix-spec';
import { generateSpec } from './cmd-generate-spec';
// Registered here, not by whichever command body happens to load: `dispatch` renders a CLI code's
// title for a refusal raised before any body is imported.
import './error-codes';
import { createHelpCommand, createVersionCommand } from './cmd-help';
import { i18nSpec } from './cmd-i18n-spec';
import { jobsSpec } from './cmd-jobs-spec';
import { manifestSpec } from './cmd-manifest-spec';
import { mcpSpec } from './cmd-mcp-spec';
import { newSpec } from './cmd-new-spec';
import { plannedCommands } from './cmd-planned';
import { policySpec } from './cmd-policy-spec';
import { prSpec } from './cmd-pr-spec';
import { actionsSpec, entitiesSpec, queriesSpec } from './cmd-registries-spec';
import { routesSpec } from './cmd-routes-spec';
import { secretsSpec } from './cmd-secrets-spec';
import { shotSpec } from './cmd-shot-spec';
import { tasksSpec } from './cmd-tasks-spec';
import { testSpec } from './cmd-test-spec';
import { verifySpec } from './cmd-verify-spec';
import type { CliCommand } from './command';
import type { CommandSpec } from './parse';
import { loadVersion } from './version-loader';

let cliVersionCache: string | undefined;

/**
 * Single source of truth for the CLI's own version — loaded from its package.json, lazily.
 * `index.ts` re-exports this module, so importing `@ultimat3/cli` for `runRole` alone — what a
 * compiled `apps/web/server.ts` does — must not read a manifest a `--compile` binary does not
 * carry. An eager `const` here reintroduced exactly the failure `frameworkVersion()` was made
 * lazy to fix, one file over: it compiled clean and threw at import on the first boot that
 * actually ran the artifact.
 */
export function cliVersion(): string {
  if (cliVersionCache === undefined) cliVersionCache = loadVersion();
  return cliVersionCache;
}

/**
 * A command whose body loads on first run. The spec is the module's own (`cmd-<name>.ts` reads
 * the same `cmd-<name>-spec.ts`), so the parser and the body can never describe two commands.
 */
export interface LazyCommand extends CliCommand {
  /** The body module's own command — what `run` delegates to, exposed so a test can hold them equal. */
  load(): Promise<CliCommand>;
}

const lazy = (spec: CommandSpec, load: () => Promise<CliCommand>): LazyCommand => ({
  spec,
  load,
  run: async (ctx) => (await load()).run(ctx),
});

/** The shipped commands, each a static declaration plus the body it loads on first run. */
export const LAZY_COMMANDS: readonly LazyCommand[] = [
  lazy(newSpec, async () => (await import('./cmd-new')).newCommand),
  lazy(devSpec, async () => (await import('./cmd-dev')).devCommand),
  lazy(buildSpec, async () => (await import('./cmd-build')).buildCommand),
  lazy(testSpec, async () => (await import('./cmd-test')).testCommand),
  lazy(verifySpec, async () => (await import('./cmd-verify')).verifyCommand),
  lazy(generateSpec, async () => (await import('./cmd-generate')).generateCommand),
  lazy(dbSpec, async () => (await import('./cmd-db')).dbCommand),
  lazy(mcpSpec, async () => (await import('./cmd-mcp')).mcpCommand),
  lazy(doctorSpec, async () => (await import('./cmd-doctor')).doctorCommand),
  lazy(deploySpec, async () => (await import('./cmd-deploy')).deployCommand),
  lazy(envSpec, async () => (await import('./cmd-env')).envCommand),
  lazy(secretsSpec, async () => (await import('./cmd-secrets')).secretsCommand),
  lazy(manifestSpec, async () => (await import('./cmd-manifest')).manifestCommand),
  lazy(routesSpec, async () => (await import('./cmd-routes')).routesCommand),
  lazy(actionsSpec, async () => (await import('./cmd-registries')).actionsCommand),
  lazy(queriesSpec, async () => (await import('./cmd-registries')).queriesCommand),
  lazy(entitiesSpec, async () => (await import('./cmd-registries')).entitiesCommand),
  lazy(jobsSpec, async () => (await import('./cmd-jobs')).jobsCommand),
  lazy(tasksSpec, async () => (await import('./cmd-tasks')).tasksCommand),
  lazy(policySpec, async () => (await import('./cmd-policy')).policyCommand),
  lazy(i18nSpec, async () => (await import('./cmd-i18n')).i18nCommand),
  lazy(errorsSpec, async () => (await import('./cmd-errors')).errorsCommand),
  lazy(docsSpec, async () => (await import('./cmd-docs')).docsCommand),
  lazy(fixSpec, async () => (await import('./cmd-fix')).fixCommand),
  lazy(affectedSpec, async () => (await import('./cmd-affected')).affectedCommand),
  lazy(shotSpec, async () => (await import('./cmd-shot')).shotCommand),
  lazy(prSpec, async () => (await import('./cmd-pr')).prCommand),
  lazy(ciSpec, async () => (await import('./cmd-ci')).ciCommand),
];

/**
 * Planned last, so `x help` reads shipped-first and the tail is honestly labelled. They are in the
 * registry rather than absent from it because "not built yet" and "not a command" are different
 * facts, and only one of them is true — see `cmd-planned.ts`.
 */
export const COMMANDS: readonly CliCommand[] = [
  ...LAZY_COMMANDS,
  ...plannedCommands(),
  createHelpCommand(() => SPECS),
  createVersionCommand(cliVersion),
];

export const SPECS: readonly CommandSpec[] = COMMANDS.map((command) => command.spec);

export const commandFor = (name: string): CliCommand | undefined =>
  COMMANDS.find(
    (command) => command.spec.name === name || (command.spec.aliases ?? []).includes(name),
  );
