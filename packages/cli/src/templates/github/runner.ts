// The `runs-on:` the workflows `x new` writes: the gate on a free GitHub-hosted runner unless the
// repository says otherwise, the image build always on that default — it needs bash and Docker,
// which a configured label need not have. Spelled once so the two cannot drift.

/** The repository variable that overrides the runner — Settings → Secrets and variables → Actions. */
export const RUNNER_VARIABLE = 'CI_RUNNER';

/**
 * The default label. GitHub-hosted and free for a public repository; a paid or self-hosted runner
 * is a choice an owner makes by setting the variable, never one a scaffold makes for them.
 */
export const DEFAULT_RUNNER = 'ubuntu-latest';

/**
 * `vars.*` is an expression context `runs-on` accepts, and an unset variable reads as `''`, so the
 * `||` falls through to the default on every repository that never set one.
 */
export const RUNS_ON = `\${{ vars.${RUNNER_VARIABLE} || '${DEFAULT_RUNNER}' }}`;
