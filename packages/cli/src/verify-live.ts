// The `live` step's one precondition: a test database. When the floor requires the step (or
// `--only` asks for it) and nothing answers, the gate starts the stack `x new` wrote
// (`verify-services.ts`) and hands its env to the suites — so "no database" is one command the
// gate runs itself, not a runner each app writes.

import type { Runner } from './exec';
import { msg } from './messages';
import { floorRequires, readVerifyFloor } from './verify-floor';
import type { LoginProbe, Probe } from './verify-services';
import {
  ensureTestServices,
  SERVICES_DOWN,
  SERVICES_UP,
  TEST_DATABASE_KEY,
} from './verify-services';
import type { StepOutcome, VerifyContext, VerifyStep } from './verify-step';

/** Whether this run asked for `live` by name or the committed floor holds it to running. */
async function liveRequired(ctx: VerifyContext): Promise<boolean> {
  const only = ctx.only === undefined ? [] : typeof ctx.only === 'string' ? [ctx.only] : ctx.only;
  if (only.includes('live')) return true;
  return floorRequires(await readVerifyFloor(ctx.root), 'live');
}

/** `ctx` whose every child sees `env` beneath its own overrides — an explicit unset still wins. */
function withEnv(ctx: VerifyContext, env: Readonly<Record<string, string>>): VerifyContext {
  const runner: Runner = (command, options) =>
    ctx.runner(command, { ...options, env: { ...env, ...options.env } });
  return { ...ctx, runner, env: { ...(ctx.env ?? Bun.env), ...env } };
}

/** The database answered, so a `live` test that skipped did so with one in reach. */
const reached = (outcome: StepOutcome): StepOutcome => ({ ...outcome, services: 'reached' });

const withWarning = (outcome: StepOutcome, warning: string): StepOutcome => ({
  ...outcome,
  warnings: [...(outcome.warnings ?? []), warning],
});

/**
 * `step` with its database found or started first. A stack that cannot be started is a WARNING on
 * this major, carrying `X_TEST_SERVICES_UNAVAILABLE` and the line to run: the suites skip exactly
 * as they did before, and a floor whose every live test skipped is still `X_VERIFY_SUITE_VANISHED`.
 * Never torn down: the next run reuses it, and the warning says how to stop it.
 */
export function withTestServices(step: VerifyStep, probe?: Probe, login?: LoginProbe): VerifyStep {
  return {
    ...step,
    async run(ctx) {
      if (!(await liveRequired(ctx))) return step.run(ctx);
      const verdict = await ensureTestServices({
        root: ctx.root,
        runner: ctx.runner,
        env: ctx.env ?? Bun.env,
        ...(probe === undefined ? {} : { probe }),
        ...(login === undefined ? {} : { login }),
      });
      if (verdict.kind === 'ambient') {
        // The caller's own URL is a database in reach; no stack and no URL is none.
        const own = (ctx.env ?? Bun.env)[TEST_DATABASE_KEY];
        const outcome = await step.run(ctx);
        return own === undefined || own === '' ? outcome : reached(outcome);
      }
      if (verdict.kind === 'unavailable') {
        const { code, cause, fix } = verdict.finding;
        return {
          ...withWarning(
            await step.run(ctx),
            msg('cli.verify.services.unavailable', { code, cause, fix }),
          ),
          services: 'unavailable',
        };
      }
      const outcome = reached(await step.run(withEnv(ctx, verdict.env)));
      // Whatever this run's `up` started, by compose's answer — a reachable Postgres beside a
      // freshly started Redis still leaves containers running; a stack already up says nothing.
      if (verdict.startedServices.length === 0) return outcome;
      return withWarning(
        outcome,
        msg('cli.verify.services.started', {
          services: verdict.startedServices.join(', '),
          command: SERVICES_UP.join(' '),
          stop: SERVICES_DOWN,
        }),
      );
    },
  };
}
